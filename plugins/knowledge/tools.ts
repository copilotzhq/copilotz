import type {
  ContentInput,
  ContentKind,
  ContentRef,
  DurableContentInput,
} from "@copilotz/copilotz/content";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import type {
  DeleteKnowledgeDocumentResult,
  KnowledgeActionCallers,
} from "./actions.ts";
import { embedKnowledgeTexts } from "./resources.ts";
import type {
  KnowledgeDocumentSourceInput,
  KnowledgeEmbeddingConfig,
  KnowledgeSearchResult,
  KnowledgeSearchScope,
} from "./types.ts";

function record(value: unknown, name = "Input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function optional(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return required(value, name);
}

function processorContext(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("Knowledge tools require a Processor context.");
  }
  return value;
}

function knowledgeAction<K extends keyof KnowledgeActionCallers>(
  context: WorkflowToolExecutionContext,
  key: K,
): KnowledgeActionCallers[K] {
  const action = (context.processor.actions as Partial<KnowledgeActionCallers>)[
    key
  ];
  if (typeof action !== "function") {
    throw new Error(`Knowledge tool requires the '${key}' Action.`);
  }
  return action as KnowledgeActionCallers[K];
}

function tool(
  input: Omit<WorkflowTool, "id"> & { id?: string },
): WorkflowTool {
  return Object.freeze({ ...input, id: input.id ?? input.key }) as WorkflowTool;
}

function kind(mediaType: string): ContentKind {
  if (mediaType.startsWith("text/")) return "text";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/json") return "json";
  return "file";
}

function stringList(
  value: unknown,
  name: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return Object.freeze(value.map((item) => required(item, name)));
}

function searchScope(value: unknown): KnowledgeSearchScope | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Knowledge scope");
  return Object.freeze({
    ...(optional(input.threadId, "Scope thread ID")
      ? { threadId: optional(input.threadId, "Scope thread ID") }
      : {}),
    ...(optional(input.agentId, "Scope agent ID")
      ? { agentId: optional(input.agentId, "Scope agent ID") }
      : {}),
    ...(stringList(input.knowledgeSpaceIds, "Knowledge space ID")
      ? {
        knowledgeSpaceIds: stringList(
          input.knowledgeSpaceIds,
          "Knowledge space ID",
        ),
      }
      : {}),
    ...(stringList(input.documentIds, "Document ID")
      ? { documentIds: stringList(input.documentIds, "Document ID") }
      : {}),
  });
}

function sourceTitle(
  input: Readonly<{
    title?: string;
    source?: string;
    assetId?: string;
  }>,
): string {
  if (input.title?.trim()) return input.title.trim();
  const source = input.source?.trim();
  if (!source) return "Document";
  if (source.startsWith("text:")) return "Document";
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

function sourceType(source: string | undefined, assetId: string | undefined) {
  if (assetId) return "asset" as const;
  if (!source) return "text" as const;
  if (source.startsWith("text:")) return "text" as const;
  return /^https?:\/\//i.test(source) ? "url" as const : "file" as const;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = boundedNumber(value, fallback, name, minimum, maximum);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${name} must be a safe integer.`);
  }
  return result;
}

/** Creates the asynchronous document-ingestion tool. */
export function createIngestDocumentTool(
  toolId = "ingest_document",
): WorkflowTool {
  const id = required(toolId, "Ingest document tool ID");
  return tool({
    key: id,
    name: "Ingest Document",
    description:
      "Add text, a URL, a runtime-adapted file path, or an existing asset to the knowledge base. Indexing continues as durable background work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          description:
            "URL, adapter-supported file path, or raw text prefixed with text:.",
        },
        assetId: {
          type: "string",
          description: "Existing canonical Copilotz asset ID.",
        },
        title: { type: "string" },
        externalId: { type: "string" },
        forceReindex: { type: "boolean", default: false },
        metadata: { type: "object", additionalProperties: true },
      },
      oneOf: [{ required: ["source"] }, { required: ["assetId"] }],
    },
    async execute(raw, value) {
      const ctx = processorContext(value);
      const input = record(raw);
      const source = optional(input.source, "Document source");
      const assetId = optional(input.assetId, "Document asset ID");
      if (Boolean(source) === Boolean(assetId)) {
        throw new TypeError("Provide exactly one of source or assetId.");
      }
      let sourceInput: KnowledgeDocumentSourceInput;
      let content: DurableContentInput = [];
      if (assetId) {
        const asset = await ctx.processor.content.get(assetId);
        if (!asset) throw new Error(`Asset '${assetId}' was not found.`);
        const ref: ContentRef = Object.freeze({
          assetId,
          kind: kind(asset.mediaType),
          role: "document.source",
          mediaType: asset.mediaType,
        });
        sourceInput = {
          kind: "content" as const,
          content: ref,
          sourceType: "asset" as const,
          sourceUri: `asset:${assetId}`,
        };
        content = await ctx.processor.content.prepare(ref, {
          operationKey: "ingest_document:source",
        });
      } else if (source!.startsWith("text:")) {
        const sourceContent: ContentInput = {
          type: "text" as const,
          text: source!.slice("text:".length),
          role: "document.source",
        };
        sourceInput = {
          kind: "content" as const,
          content: sourceContent,
          sourceType: "text" as const,
        };
        content = await ctx.processor.content.prepare(sourceContent, {
          operationKey: "ingest_document:source",
        });
      } else {
        sourceInput = { kind: "uri" as const, uri: source! };
      }
      const suppliedMetadata = input.metadata === undefined
        ? {}
        : structuredClone(record(input.metadata, "Document metadata"));
      const suppliedScope = suppliedMetadata.scope === undefined
        ? {}
        : record(suppliedMetadata.scope, "Document metadata scope");
      const metadata = {
        ...suppliedMetadata,
        scope: {
          threadId: ctx.execution.threadId,
          ...(ctx.execution.agentId ? { agentId: ctx.execution.agentId } : {}),
          ...suppliedScope,
        },
      };
      const externalId = optional(input.externalId, "Document external ID");
      if (
        externalId && ctx.processor.collections.document.queries.byExternalId
      ) {
        const [existing] = await ctx.processor.collections.document.queries
          .byExternalId({ externalId });
        if (existing) {
          throw new Error(
            `Document external ID '${externalId}' already exists.`,
          );
        }
      }
      const documentId = `document:${ctx.execution.id}`;
      const title = sourceTitle({
        title: optional(input.title, "Document title"),
        source,
        assetId,
      });
      const created = await ctx.processor.collections.document.create({
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
        threadId: ctx.execution.threadId,
        requestedByParticipantId: ctx.execution.participantId ?? null,
        forceReindex: input.forceReindex === true,
        error: null,
        externalId: externalId ?? null,
        metadata,
      }, { operationKey: "ingest_document" });
      return {
        status: "pending",
        message: `Document "${created.title}" accepted for ingestion.`,
        documentId: created.id,
        source: source ?? `asset:${assetId}`,
        title: created.title,
        namespace: ctx.namespace,
      };
    },
  });
}

/** Creates the semantic knowledge-search tool. */
export function createSearchKnowledgeTool(
  embedding: KnowledgeEmbeddingConfig,
  toolId = "search_knowledge",
): WorkflowTool {
  const id = required(toolId, "Search knowledge tool ID");
  return tool({
    key: id,
    name: "Search Knowledge Base",
    description:
      "Search indexed document chunks by semantic similarity within the current tenant and graph scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        scope: {
          type: "object",
          additionalProperties: false,
          properties: {
            threadId: { type: "string" },
            agentId: { type: "string" },
            knowledgeSpaceIds: {
              type: "array",
              items: { type: "string" },
            },
            documentIds: { type: "array", items: { type: "string" } },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        threshold: { type: "number", minimum: -1, maximum: 1, default: 0.5 },
      },
      required: ["query"],
    },
    async execute(raw, value) {
      const ctx = processorContext(value);
      const searchKnowledge = knowledgeAction(ctx, "searchKnowledge");
      const input = record(raw);
      const query = required(input.query, "Knowledge query");
      const explicitScope = searchScope(input.scope);
      const response = await embedKnowledgeTexts(
        {
          embeddings: ctx.processor.adapters.embedding ?? Object.freeze({}),
        },
        embedding,
        [query],
        {
          signal: ctx.processor.signal,
          idempotencyKey: `${ctx.idempotencyKey}:knowledge-query`,
        },
      );
      const results = await searchKnowledge({
        embedding: response.embeddings[0],
        scope: {
          threadId: ctx.execution.threadId,
          ...(ctx.execution.agentId ? { agentId: ctx.execution.agentId } : {}),
          ...explicitScope,
        },
        limit: boundedInteger(
          input.limit,
          5,
          "Knowledge result limit",
          1,
          20,
        ),
        threshold: boundedNumber(
          input.threshold,
          0.5,
          "Knowledge similarity threshold",
          -1,
          1,
        ),
      }, {
        operationKey: "search_knowledge",
        signal: ctx.processor.signal,
      }) as readonly KnowledgeSearchResult[];
      if (results.length === 0) {
        return {
          results: [],
          message: "No relevant documents found for the query.",
          query,
          namespace: ctx.namespace,
        };
      }
      return {
        results: results.map((result) => ({
          content: result.chunk.content,
          score: Math.round(result.similarity * 100) / 100,
          source: result.document.title || result.document.sourceUri ||
            "Unknown",
          namespace: result.document.namespace,
          documentId: result.document.id,
          chunkIndex: result.chunk.chunkIndex,
        })),
        query,
        namespace: ctx.namespace,
        totalResults: results.length,
      };
    },
  });
}

/** Creates the typed aggregate-deletion tool. */
export function createDeleteDocumentTool(
  toolId = "delete_document",
): WorkflowTool {
  const id = required(toolId, "Delete document tool ID");
  return tool({
    key: id,
    name: "Delete Document",
    description:
      "Remove one document and its derived chunks by document ID or source URI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string" },
        sourceUri: { type: "string" },
      },
      oneOf: [{ required: ["documentId"] }, { required: ["sourceUri"] }],
    },
    async execute(raw, value) {
      const ctx = processorContext(value);
      const deleteKnowledgeDocument = knowledgeAction(
        ctx,
        "deleteKnowledgeDocument",
      );
      const input = record(raw);
      const documentId = optional(input.documentId, "Document ID");
      const sourceUri = optional(input.sourceUri, "Document source URI");
      if (Boolean(documentId) === Boolean(sourceUri)) {
        throw new TypeError("Provide exactly one of documentId or sourceUri.");
      }
      return await deleteKnowledgeDocument({
        ...(documentId ? { documentId } : {}),
        ...(sourceUri ? { sourceUri } : {}),
      }, {
        operationKey: "delete_document",
        signal: ctx.processor.signal,
      }) as DeleteKnowledgeDocumentResult;
    },
  });
}
