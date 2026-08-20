import { digestContent } from "../content/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { chunkText } from "../../utils/chunker.ts";
import {
  KNOWLEDGE_DOCUMENT_COLLECTION,
  knowledgeChunkCollection,
  knowledgeDocumentCollection,
} from "./collections.ts";
import { embedKnowledgeTexts } from "./resources.ts";
import {
  createDefaultKnowledgeSourceLoader,
  createDefaultKnowledgeTextExtractor,
} from "./source.ts";
import {
  createDeleteDocumentTool,
  createIngestDocumentTool,
  createSearchKnowledgeTool,
} from "./tools.ts";
import type {
  CreateKnowledgePluginOptions,
  KnowledgeChunkingConfig,
  KnowledgeDocument,
  KnowledgeEmbeddingConfig,
  KnowledgeSourceLoader,
  KnowledgeTextExtractor,
  LoadedKnowledgeSource,
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
    provider: required(value.provider, "Embedding provider resource ID"),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof TypeError) return "knowledge_input_invalid";
  if (error instanceof DOMException && error.name === "AbortError") {
    return "knowledge_cancelled";
  }
  return "knowledge_index_failed";
}

async function loadSource(
  document: KnowledgeDocument,
  context: CopilotzProcessorContext,
  loader: KnowledgeSourceLoader,
): Promise<LoadedKnowledgeSource> {
  if (document.source.length) {
    if (document.source.length !== 1) {
      throw new Error(`Document '${document.id}' has multiple source assets.`);
    }
    const [resolved] = await context.content.resolveMany(document.source);
    return Object.freeze({
      bytes: resolved.bytes,
      mediaType: resolved.asset.mediaType,
      sourceType: document.sourceType,
      sourceUri: document.sourceUri,
      title: document.title,
    });
  }
  return await loader({
    document,
    signal: context.signal,
    idempotencyKey: `${context.idempotencyKey}:knowledge-source`,
  });
}

async function announce(
  context: CopilotzProcessorContext,
  document: KnowledgeDocument,
  input: Readonly<{
    status: "indexed" | "duplicate" | "failed";
    message: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<void> {
  if (!document.threadId) return;
  if (!await context.collections.thread.get({ id: document.threadId })) return;
  const messageId = `${document.id}:knowledge:${input.status}`;
  const prepared = await context.content.prepare({
    type: "text",
    text: input.message,
    role: "body",
  }, { operationKey: `knowledge-announce:${document.id}:${input.status}` });
  const content = await context.content.materialize(prepared, {
    origin: {
      scope: { type: "thread", id: document.threadId },
      producer: { type: "message", id: messageId },
    },
  });
  await context.features.threadMessage.create({
    id: messageId,
    threadId: document.threadId,
    sender: {
      externalId: "copilotz.knowledge",
      participantType: "job",
      name: "RAG",
    },
    recipientIds: [],
    content,
    visibility: { kind: "public" },
    metadata: {
      knowledgeResult: {
        documentId: document.id,
        title: document.title,
        status: input.status,
        ...structuredClone(input.metadata ?? {}),
      },
    },
  }, { operationKey: `knowledge-announce:${document.id}:${input.status}` });
  if (content.length) await context.content.linkOwner(messageId, content);
}

function createIndexProcessor(
  options: Readonly<{
    embedding: KnowledgeEmbeddingConfig;
    chunking: Required<KnowledgeChunkingConfig>;
    loader: KnowledgeSourceLoader;
    extractor: KnowledgeTextExtractor;
  }>,
) {
  return defineProcessor<CopilotzProcessorContext>({
    id: PROCESSOR_ID,
    on: [{
      eventType: "document.created",
      subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const id = event.subject.id;
      let document = await context.knowledge.get(id);
      if (!document) throw new Error(`Knowledge document '${id}' vanished.`);
      let settled = false;
      try {
        document = (await context.knowledge.begin(id, {
          operationKey: `index:${id}:begin`,
        })).value!;
        const loaded = await loadSource(document, context, options.loader);
        context.signal.throwIfAborted();
        const text = (await options.extractor({
          bytes: loaded.bytes,
          mediaType: loaded.mediaType,
          signal: context.signal,
        })).trim();
        if (!text) throw new Error("Document has no text to index.");
        const hash = await digestContent(loaded.bytes);
        const canonical = document.forceReindex
          ? null
          : await context.knowledge.getByHash(hash);
        if (canonical && canonical.id !== document.id) {
          document = (await context.knowledge.markDuplicate({
            id,
            duplicateOfDocumentId: canonical.id,
            source: canonical.source,
            mediaType: canonical.mediaType ?? loaded.mediaType,
            contentHash: hash,
          }, { operationKey: `index:${id}:duplicate` })).value!;
          settled = true;
          await announce(context, document, {
            status: "duplicate",
            message: `Document "${document.title}" already indexed (hash: ${
              hash.slice(7, 15)
            }...).`,
            metadata: { duplicateOfDocumentId: canonical.id },
          });
          return;
        }

        const chunks = chunkText(text, options.chunking);
        if (chunks.length === 0) {
          throw new Error("Document has no content to index.");
        }
        const vectors: (readonly number[])[] = [];
        const batchSize = options.embedding.batchSize!;
        let model = options.embedding.model;
        let dimensions = options.embedding.dimensions;
        for (let offset = 0; offset < chunks.length; offset += batchSize) {
          context.signal.throwIfAborted();
          const batch = chunks.slice(offset, offset + batchSize);
          const response = await embedKnowledgeTexts(
            context.resources,
            options.embedding,
            batch.map((item) => item.content),
            {
              signal: context.signal,
              idempotencyKey:
                `${context.idempotencyKey}:knowledge-embed:${offset}`,
            },
          );
          vectors.push(...response.embeddings);
          model = response.model;
          dimensions = response.dimensions;
        }
        const source = document.source.length
          ? document.source
          : await context.content.prepare({
            type: "file",
            bytes: loaded.bytes,
            mediaType: loaded.mediaType,
            role: "document.source",
            ...(loaded.title ? { name: loaded.title } : {}),
          }, { operationKey: `index:${id}:source` });
        document = (await context.knowledge.complete({
          id,
          title: loaded.title ?? document.title,
          mediaType: loaded.mediaType,
          contentHash: hash,
          source,
          chunks: chunks.map((chunk, index) => ({
            content: chunk.content,
            embedding: vectors[index],
            chunkIndex: chunk.metadata.chunkIndex,
            tokenCount: chunk.metadata.tokenCount,
            startPosition: chunk.metadata.startPosition,
            endPosition: chunk.metadata.endPosition,
            metadata: {
              ...(model ? { embeddingModel: model } : {}),
              ...(dimensions ? { embeddingDimensions: dimensions } : {}),
            },
          })),
        }, { operationKey: `index:${id}:complete` })).value!;
        settled = true;
        await announce(context, document, {
          status: "indexed",
          message:
            `Successfully indexed "${document.title}" (${document.chunkCount} chunks).`,
          metadata: { chunks: document.chunkCount },
        });
      } catch (error) {
        if (!settled) {
          const failed = await context.knowledge.fail({
            id,
            error: {
              code: errorCode(error),
              message: errorMessage(error),
            },
          }, { operationKey: `index:${id}:fail` }).catch(() => undefined);
          document = failed?.value ?? document;
          if (context.delivery.attempts >= context.delivery.maxAttempts) {
            await announce(context, document, {
              status: "failed",
              message: `❌ Failed to ingest document: ${errorMessage(error)}`,
            }).catch(() => undefined);
          }
        }
        throw error;
      }
    },
  });
}

/** Packages graph collections, durable indexing, and optional RAG tools. */
export function createKnowledgePlugin(
  input: CreateKnowledgePluginOptions,
): CopilotzPlugin {
  const pluginId = input.id?.trim() || DEFAULT_ID;
  const embeddingConfig = embedding(input.embedding);
  const processor = createIndexProcessor({
    embedding: embeddingConfig,
    chunking: chunking(input.chunking),
    loader: input.sourceLoader ?? createDefaultKnowledgeSourceLoader(),
    extractor: input.extractText ?? createDefaultKnowledgeTextExtractor(),
  });
  const tools = input.tools === false ? [] : [
    createIngestDocumentTool(input.tools?.ingestId),
    createSearchKnowledgeTool(embeddingConfig, input.tools?.searchId),
    createDeleteDocumentTool(input.tools?.deleteId),
  ];
  return definePlugin({
    manifest: {
      id: pluginId,
      version: input.version?.trim() || DEFAULT_VERSION,
      provides: {
        collections: [
          knowledgeDocumentCollection.name,
          knowledgeChunkCollection.name,
        ],
        processors: [processor.id],
        ...(tools.length ? { tools: tools.map((item) => item.key) } : {}),
      },
    },
    resources: {
      collections: [knowledgeDocumentCollection, knowledgeChunkCollection],
      processors: [processor],
      ...(tools.length ? { tools } : {}),
    },
  });
}
