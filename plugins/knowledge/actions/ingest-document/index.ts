/** Owns the ingest-document Knowledge Action. @module */
import type {
  ContentInput,
  ContentKind,
  ContentRef,
  DurableContentInput,
} from "@copilotz/copilotz/content";

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { KnowledgeDocumentSourceInput } from "../../internal/types.ts";

import { optional, record } from "../internal/input.ts";
export const INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.ingestDocument";

export type IngestKnowledgeDocumentInput = Readonly<{
  source?: string;
  assetId?: string;
  title?: string;
  externalId?: string;
  forceReindex?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type IngestKnowledgeDocumentResult = Readonly<{
  status: "pending";
  message: string;
  documentId: string;
  source: string;
  title: string;
  namespace: string;
}>;

function sourceTitle(
  input: Readonly<{
    title?: string;
    source?: string;
    assetId?: string;
  }>,
): string {
  if (input.title?.trim()) return input.title.trim();
  const source = input.source?.trim();
  if (!source || source.startsWith("text:")) return "Document";
  if (/^https?:\/\//i.test(source)) {
    try {
      const parsed = new URL(source);
      return parsed.pathname.split("/").filter(Boolean).at(-1) ||
        parsed.hostname;
    } catch {
      return source;
    }
  }
  return source.split(/[\\/]/).filter(Boolean).at(-1) || source ||
    input.assetId || "Document";
}

const ingestDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string" },
    assetId: { type: "string" },
    title: { type: "string" },
    externalId: { type: "string" },
    forceReindex: { type: "boolean", default: false },
    metadata: { type: "object", additionalProperties: true },
  },
  oneOf: [{ required: ["source"] }, { required: ["assetId"] }],
} as const;

const ingestDocumentOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "pending" },
    message: { type: "string" },
    documentId: { type: "string" },
    source: { type: "string" },
    title: { type: "string" },
    namespace: { type: "string" },
  },
  required: [
    "status",
    "message",
    "documentId",
    "source",
    "title",
    "namespace",
  ],
} as const;

/** Accepts a source and creates a pending document for durable indexing. */
export const ingestKnowledgeDocumentAction: ActionDefinition<
  IngestKnowledgeDocumentInput,
  IngestKnowledgeDocumentResult,
  ActionContext,
  typeof ingestDocumentInputSchema,
  typeof ingestDocumentOutputSchema
> = defineAction<
  IngestKnowledgeDocumentInput,
  IngestKnowledgeDocumentResult,
  ActionContext,
  typeof ingestDocumentInputSchema,
  typeof ingestDocumentOutputSchema
>({
  id: INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  inputSchema: ingestDocumentInputSchema,
  outputSchema: ingestDocumentOutputSchema,
  async execute(raw, context: ActionContext) {
    const input = record(raw);
    const source = optional(input.source, "Document source");
    const assetId = optional(input.assetId, "Document asset ID");
    if (Boolean(source) === Boolean(assetId)) {
      throw new TypeError("Provide exactly one of source or assetId.");
    }

    let sourceInput: KnowledgeDocumentSourceInput;
    let content: DurableContentInput = [];
    if (assetId) {
      const asset = await context.content.get(assetId);
      if (!asset) throw new Error(`Asset '${assetId}' was not found.`);
      const ref: ContentRef = {
        assetId,
        kind: kind(asset.mediaType),
        role: "document.source",
        mediaType: asset.mediaType,
      } as const;
      sourceInput = {
        kind: "content",
        content: ref,
        sourceType: "asset",
        sourceUri: `asset:${assetId}`,
      };
      content = await context.content.prepare(ref, {
        operationKey: `${context.operationKey}:source`,
      });
    } else if (source!.startsWith("text:")) {
      const sourceContent: ContentInput = {
        type: "text",
        text: source!.slice("text:".length),
        role: "document.source",
      };
      sourceInput = {
        kind: "content",
        content: sourceContent,
        sourceType: "text",
      };
      content = await context.content.prepare(sourceContent, {
        operationKey: `${context.operationKey}:source`,
      });
    } else {
      sourceInput = { kind: "uri", uri: source! };
    }

    const actionMetadata = record(context.action.metadata, "Action metadata");
    const threadId = optional(actionMetadata.threadId, "Action thread ID");
    const agentId = optional(actionMetadata.agentId, "Action agent ID");
    const participantId = optional(
      actionMetadata.initiatorParticipantId,
      "Action initiator participant ID",
    );
    const suppliedMetadata = input.metadata === undefined
      ? {}
      : structuredClone(record(input.metadata, "Document metadata"));
    const suppliedScope = suppliedMetadata.scope === undefined
      ? {}
      : record(suppliedMetadata.scope, "Document metadata scope");
    const metadata = {
      ...suppliedMetadata,
      ...(threadId ? { threadId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(participantId ? { initiatorParticipantId: participantId } : {}),
      scope: {
        ...suppliedScope,
        ...(threadId ? { threadId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(participantId ? { initiatorParticipantId: participantId } : {}),
      },
    };
    const externalId = optional(input.externalId, "Document external ID");
    if (externalId && context.collections.document.queries.byExternalId) {
      const [existing] = await context.collections.document.queries
        .byExternalId({
          externalId,
        });
      if (existing) {
        throw new Error(`Document external ID '${externalId}' already exists.`);
      }
    }

    const documentId = `document:${context.action.runId}`;
    const title = sourceTitle({
      title: optional(input.title, "Document title"),
      source,
      assetId,
    });
    const created = await context.collections.document.create({
      id: documentId,
      sourceType: sourceType(source, assetId),
      sourceUri: sourceInput.kind === "uri"
        ? sourceInput.uri
        : sourceInput.sourceUri ?? (assetId ? `asset:${assetId}` : null),
      title,
      mediaType: null,
      contentHash: null,
      source: content,
      status: "pending",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId: threadId ?? null,
      requestedByParticipantId: participantId ?? null,
      forceReindex: input.forceReindex === true,
      error: null,
      externalId: externalId ?? null,
      metadata,
    }, { operationKey: `${context.operationKey}:document` });
    const createdTitle = String(created.title);
    return ({
      status: "pending",
      message: `Document "${createdTitle}" accepted for ingestion.`,
      documentId: created.id,
      source: source ?? `asset:${assetId}`,
      title: createdTitle,
      namespace: context.namespace,
    } as const);
  },
});

function kind(mediaType: string): ContentKind {
  if (mediaType.startsWith("text/")) return "text";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/json") return "json";
  return "file";
}
function sourceType(
  source: string | undefined,
  assetId: string | undefined,
) {
  if (assetId) return "asset" as const;
  if (!source || source.startsWith("text:")) return "text" as const;
  return /^https?:\/\//i.test(source) ? "url" as const : "file" as const;
}
