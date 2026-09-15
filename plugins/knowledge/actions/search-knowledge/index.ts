import { knowledgeConfig } from "../../internal/config.ts";
/** Owns the search-knowledge Knowledge Action. @module */
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { embedKnowledgeTexts } from "../../resources/embedding/index.ts";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
} from "../../internal/types.ts";

import type { KnowledgeActionContext } from "../internal/context.ts";
import {
  finiteVector,
  optional,
  record,
  requireText,
} from "../internal/input.ts";
import { documentMatchesScope, stringList } from "../internal/records.ts";
export const SEARCH_KNOWLEDGE_ACTION_ID = "copilotz.knowledge.searchDocuments";

export type SearchKnowledgeActionInput = Readonly<{
  query: string;
  scope?: Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"];
  limit?: number;
  threshold?: number;
}>;

export type SearchKnowledgeActionResult = Readonly<{
  results: readonly Readonly<{
    content: string;
    score: number;
    source: string;
    namespace: string;
    documentId: string;
    chunkIndex: number;
  }>[];
  query: string;
  namespace: string;
  totalResults?: number;
  message?: string;
}>;

function similarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function searchScope(
  value: unknown,
): Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"] {
  if (value === undefined) return undefined;
  const input = record(value, "Knowledge search scope");
  return ({
    ...(optional(input.threadId, "Scope thread ID")
      ? { threadId: optional(input.threadId, "Scope thread ID") }
      : {}),
    ...(optional(input.agentId, "Scope agent ID")
      ? { agentId: optional(input.agentId, "Scope agent ID") }
      : {}),
    ...(stringList(input.knowledgeSpaceIds).length
      ? { knowledgeSpaceIds: stringList(input.knowledgeSpaceIds) }
      : {}),
    ...(stringList(input.documentIds).length
      ? { documentIds: stringList(input.documentIds) }
      : {}),
  } as const);
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

async function listAllChunks(
  context: Pick<ActionContext, "collections">,
): Promise<readonly KnowledgeChunk[]> {
  const chunks = context.collections.chunk;
  const collected: KnowledgeChunk[] = [];
  let after: string | undefined;
  while (true) {
    const page = await chunks.list({
      ...(after ? { after } : {}),
      limit: 1_000,
    }) as readonly KnowledgeChunk[];
    collected.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
    if (!after) break;
  }
  return collected;
}

async function searchDocuments(
  input: unknown,
  context: ActionContext,
): Promise<readonly KnowledgeSearchResult[]> {
  const data = record(input);
  const embedding = finiteVector(data.embedding, "Knowledge query embedding");
  const scope = searchScope(data.scope);
  if (scope?.documentIds?.length === 0) return ([] as const);
  const limit = boundedInteger(
    data.limit,
    100,
    "Knowledge result limit",
    1,
    100,
  );
  const threshold = boundedNumber(
    data.threshold,
    -1,
    "Knowledge similarity threshold",
    -1,
    1,
  );
  const documents = context.collections.document;
  const documentCache = new Map<string, KnowledgeDocument | null>();
  const results: KnowledgeSearchResult[] = [];
  for (const chunk of await listAllChunks(context)) {
    let document = documentCache.get(chunk.documentId);
    if (document === undefined) {
      document = await documents.get({ id: chunk.documentId }) as
        | KnowledgeDocument
        | null;
      documentCache.set(chunk.documentId, document);
    }
    if (!document || document.status !== "indexed") continue;
    if (!documentMatchesScope(document, scope)) continue;
    const score = similarity(
      embedding,
      finiteVector(chunk.embedding, "Chunk embedding"),
    );
    if (score < threshold) continue;
    results.push({ chunk, document, similarity: score } as const);
  }
  results.sort((left, right) =>
    right.similarity - left.similarity ||
    left.chunk.documentId.localeCompare(right.chunk.documentId) ||
    left.chunk.chunkIndex - right.chunk.chunkIndex
  );
  return (results.slice(0, limit));
}

const searchKnowledgeInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1 },
    scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string" },
        agentId: { type: "string" },
        knowledgeSpaceIds: { type: "array", items: { type: "string" } },
        documentIds: { type: "array", items: { type: "string" } },
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    threshold: { type: "number", minimum: -1, maximum: 1, default: 0.5 },
  },
  required: ["query"],
} as const;

const searchKnowledgeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          score: { type: "number" },
          source: { type: "string" },
          namespace: { type: "string" },
          documentId: { type: "string" },
          chunkIndex: { type: "integer", minimum: 0 },
        },
        required: [
          "content",
          "score",
          "source",
          "namespace",
          "documentId",
          "chunkIndex",
        ],
      },
    },
    query: { type: "string" },
    namespace: { type: "string" },
    totalResults: { type: "integer", minimum: 0 },
    message: { type: "string" },
  },
  required: ["results", "query", "namespace"],
} as const;

/** Creates one provider-configured action for searching indexed documents. */

export const searchKnowledgeAction: ActionDefinition<
  SearchKnowledgeActionInput,
  SearchKnowledgeActionResult,
  KnowledgeActionContext,
  typeof searchKnowledgeInputSchema,
  typeof searchKnowledgeOutputSchema
> = defineAction<
  SearchKnowledgeActionInput,
  SearchKnowledgeActionResult,
  KnowledgeActionContext,
  typeof searchKnowledgeInputSchema,
  typeof searchKnowledgeOutputSchema
>({
  id: SEARCH_KNOWLEDGE_ACTION_ID,
  inputSchema: searchKnowledgeInputSchema,
  outputSchema: searchKnowledgeOutputSchema,
  async execute(raw, context: KnowledgeActionContext) {
    const { embedding } = knowledgeConfig(context);
    const input = record(raw);
    const query = requireText(input.query, "Knowledge query");
    const explicitScope = searchScope(input.scope);
    const actionMetadata = record(context.action.metadata, "Action metadata");
    const threadId = optional(actionMetadata.threadId, "Action thread ID");
    const agentId = optional(actionMetadata.agentId, "Action agent ID");
    const response = await embedKnowledgeTexts(
      { embeddings: context.adapters.embedding ?? ({} as const) },
      embedding,
      [query],
      {
        signal: context.signal,
        idempotencyKey: `${context.operationKey}:knowledge-query`,
      },
    );
    const results = await searchDocuments({
      embedding: response.embeddings[0],
      scope: {
        ...explicitScope,
        ...(threadId ? { threadId } : {}),
        ...(agentId ? { agentId } : {}),
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
    }, context);
    if (results.length === 0) {
      return ({
        results: [] as const,
        message: "No relevant documents found for the query.",
        query,
        namespace: context.namespace,
      } as const);
    }
    return ({
      results: results.map((result) => ({
        content: result.chunk.content,
        score: Math.round(result.similarity * 100) / 100,
        source: result.document.title || result.document.sourceUri ||
          "Unknown",
        namespace: result.document.namespace,
        documentId: result.document.id,
        chunkIndex: result.chunk.chunkIndex,
      } as const)),
      query,
      namespace: context.namespace,
      totalResults: results.length,
    } as const);
  },
});

export type SearchKnowledgeAction = typeof searchKnowledgeAction;
