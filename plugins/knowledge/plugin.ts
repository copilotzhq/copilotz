import {
  type AnyActionDefinition,
  isSettledActionError,
} from "@copilotz/copilotz/actions";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { ToolResource } from "@copilotz/copilotz/tools";
import {
  createIndexKnowledgeDocumentAction,
  type IndexKnowledgeDocumentAction,
  type KnowledgeIndexActionCallers,
} from "./actions.ts";
import {
  KNOWLEDGE_DOCUMENT_COLLECTION,
  knowledgeChunkCollection,
  knowledgeDocumentCollection,
} from "./collections.ts";
import {
  createDefaultKnowledgeSourceLoader,
  createDefaultKnowledgeTextExtractor,
} from "./source.ts";
import { createKnowledgeActionResources } from "./tools.ts";
import type {
  CreateKnowledgePluginOptions,
  KnowledgeChunkingConfig,
  KnowledgeEmbeddingConfig,
} from "./types.ts";

const DEFAULT_ID = "@copilotz/knowledge";
const DEFAULT_VERSION = "3.0.0";
const PROCESSOR_ID = "copilotz.knowledge.index-document";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return result;
}

function chunking(value: KnowledgeChunkingConfig = {}): Required<
  KnowledgeChunkingConfig
> {
  const chunkSize = positiveInteger(value.chunkSize, 512, "Chunk size");
  const chunkOverlap = value.chunkOverlap ?? 50;
  if (
    !Number.isSafeInteger(chunkOverlap) || chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    throw new TypeError("Chunk overlap must be at least zero and below size.");
  }
  return Object.freeze({
    strategy: value.strategy ?? "fixed",
    chunkSize,
    chunkOverlap,
  });
}

function embedding(value: KnowledgeEmbeddingConfig): KnowledgeEmbeddingConfig {
  return Object.freeze({
    provider: required(value.provider, "Embedding provider Adapter ID"),
    ...(value.model?.trim() ? { model: value.model.trim() } : {}),
    ...(value.dimensions === undefined ? {} : {
      dimensions: positiveInteger(
        value.dimensions,
        value.dimensions,
        "Embedding dimensions",
      ),
    }),
    batchSize: positiveInteger(value.batchSize, 100, "Embedding batch size"),
  });
}

type KnowledgeProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{ actions: KnowledgeIndexActionCallers }>;

function createIndexProcessor(): Processor<KnowledgeProcessorContext> {
  return defineProcessor<KnowledgeProcessorContext>({
    id: PROCESSOR_ID,
    on: [{
      eventType: "document.created",
      subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      try {
        await context.actions.indexKnowledgeDocument({
          id: event.subject.id,
        }, {
          operationKey: `index:${event.subject.id}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: event.deduplicationId,
            settlementScopeId: context.identity.settlementScopeId,
          },
          signal: context.signal,
        });
      } catch (error) {
        // A durable Action failure is a settled semantic outcome. Only an
        // infrastructure failure before lifecycle settlement retries delivery.
        if (!isSettledActionError(error)) throw error;
      }
    },
  });
}

type KnowledgeCollections = Readonly<{
  document: typeof knowledgeDocumentCollection;
  chunk: typeof knowledgeChunkCollection;
}>;

type KnowledgeActions =
  & Readonly<{ indexKnowledgeDocument: IndexKnowledgeDocumentAction }>
  & Readonly<Record<string, AnyActionDefinition>>;

type KnowledgeProcessors = Readonly<{
  indexKnowledgeDocument: Processor<KnowledgeProcessorContext>;
}>;

type KnowledgeTools = Readonly<Record<string, ToolResource>>;

type KnowledgeResources = Readonly<{ tools: KnowledgeTools }>;

export type KnowledgePlugin = CopilotzPlugin<
  string,
  string,
  readonly [],
  KnowledgeCollections,
  KnowledgeActions,
  KnowledgeProcessors,
  KnowledgeResources,
  Readonly<Record<never, never>>
>;

/** Packages Knowledge Collections, Actions, Processors, and Tool Resources. */
export function createKnowledgePlugin(
  input: CreateKnowledgePluginOptions,
): KnowledgePlugin {
  const embeddingConfig = embedding(input.embedding);
  const contribution = input.tools === false
    ? Object.freeze({
      actions: Object.freeze({}),
      tools: Object.freeze({}),
    })
    : createKnowledgeActionResources(embeddingConfig, input.tools);
  if (Object.hasOwn(contribution.actions, "indexKnowledgeDocument")) {
    throw new TypeError(
      "Knowledge Tool Action alias 'indexKnowledgeDocument' is reserved.",
    );
  }
  const actions = Object.freeze({
    indexKnowledgeDocument: createIndexKnowledgeDocumentAction({
      embedding: embeddingConfig,
      chunking: chunking(input.chunking),
      loader: input.sourceLoader ?? createDefaultKnowledgeSourceLoader(),
      extractor: input.extractText ?? createDefaultKnowledgeTextExtractor(),
    }),
    ...contribution.actions,
  });
  return definePlugin({
    id: input.id?.trim() || DEFAULT_ID,
    version: input.version?.trim() || DEFAULT_VERSION,
    collections: {
      document: knowledgeDocumentCollection,
      chunk: knowledgeChunkCollection,
    },
    actions,
    processors: { indexKnowledgeDocument: createIndexProcessor() },
    resources: { tools: contribution.tools },
  });
}
