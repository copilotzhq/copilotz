/**
 * RAG_INGEST Event Processor
 *
 * Handles document ingestion pipeline:
 * 1. Fetch document content
 * 2. Preprocess and chunk
 * 3. Generate embeddings
 * 4. Store in database
 */

import type {
  Event,
  EventProcessor,
  NewEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import type { RagIngestPayload } from "@/database/schemas/index.ts";

import { fetchDocument, preprocessContent } from "@/utils/document-fetcher.ts";
import { chunkText, hashContentSHA256 } from "@/utils/chunker.ts";
import { embed } from "@/runtime/embeddings/index.ts";
import { createRagDataServices } from "@/runtime/collections/native.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export const processorId = "rag_ingest";
export const eventTypes = ["rag_ingestion.created"] as const;

export type { RagIngestPayload };

// Local Document type to avoid circular dependency issues
interface DocumentRecord {
  id: string;
  namespace: string;
  status: string;
}

function isRagIngestPayload(payload: unknown): payload is RagIngestPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.source === "string";
}

export const ragIngestProcessor: EventProcessor<
  RagIngestPayload,
  ProcessorDeps
> = {
  shouldProcess: (event: Event) => {
    // RAG_INGEST is a custom event type
    const eventType = (event as unknown as { type: string }).type;
    const eventPayload = (event as unknown as { payload: unknown }).payload;
    return (eventType === "RAG_INGEST" ||
      eventType === "rag_ingestion.created") &&
      isRagIngestPayload(eventPayload);
  },

  process: async (event: Event, deps: ProcessorDeps) => {
    const { db, thread, context } = deps;
    const ops = db.ops;
    const ragData = createRagDataServices({
      collections: context.collections,
      ops,
    });
    const payload = (event as unknown as { payload: RagIngestPayload }).payload;

    const eventThreadId = (event as unknown as { threadId?: string }).threadId;
    const threadId: string = typeof eventThreadId === "string"
      ? eventThreadId
      : String(thread.id);

    const {
      source,
      title: providedTitle,
      namespace: payloadNamespace,
      metadata = {},
      forceReindex = false,
    } = payload;
    const namespace = payloadNamespace ?? context.namespace;
    if (!namespace) {
      return await createErrorResponse(
        threadId,
        event,
        deps,
        "RAG",
        "Tenant namespace not available for RAG ingestion.",
      );
    }

    // Get embedding config from context
    const embeddingConfig = context.embeddingConfig ??
      context.ragConfig?.embedding;
    if (!embeddingConfig) {
      return await createErrorResponse(
        threadId,
        event,
        deps,
        "RAG",
        "Embedding configuration not available. Ensure RAG is enabled in copilotz config.",
      );
    }

    // Get chunking config
    const chunkingConfig = context.ragConfig?.chunking ?? {
      strategy: "fixed" as const,
      chunkSize: 512,
      chunkOverlap: 50,
    };

    try {
      // Step 1: Fetch document
      const fetchedDoc = await fetchDocument(source);
      const title = providedTitle || fetchedDoc.title || "Untitled";

      // Step 2: Preprocess content
      const processedContent = preprocessContent(
        fetchedDoc.content,
        fetchedDoc.mimeType,
      );

      // Step 3: Calculate hash for deduplication
      const contentHash = await hashContentSHA256(processedContent);

      // Check for existing document with same hash
      if (!forceReindex) {
        const existing = await ragData.getDocumentByHash(
          contentHash,
          namespace,
        ) as DocumentRecord | undefined;
        if (existing && existing.status === "indexed") {
          return await createSuccessResponse(
            threadId,
            event,
            deps,
            "RAG",
            `Document "${title}" already indexed (hash: ${
              contentHash.slice(0, 8)
            }...).`,
            { documentId: existing.id, status: "skipped" },
          );
        }

        // If existing but failed, delete and reindex
        if (existing) {
          await ragData.deleteDocument(existing.id, namespace);
        }
      }

      // Step 4: Create document record
      const document = await ragData.createDocument({
        namespace,
        sourceType: fetchedDoc.sourceType,
        sourceUri: fetchedDoc.sourceUri,
        title,
        mimeType: fetchedDoc.mimeType,
        contentHash,
        status: "processing",
        metadata: {
          ...metadata,
          originalSize: fetchedDoc.size,
        },
      }) as DocumentRecord;

      // Step 5: Chunk content
      const chunks = chunkText(processedContent, {
        chunkSize: chunkingConfig.chunkSize ?? 512,
        chunkOverlap: chunkingConfig.chunkOverlap ?? 50,
        strategy: chunkingConfig.strategy ?? "fixed",
      });

      if (chunks.length === 0) {
        await ragData.updateDocumentStatus(
          document.id,
          namespace,
          "failed",
          "No content to index",
        );
        return await createErrorResponse(
          threadId,
          event,
          deps,
          "RAG",
          `Document "${title}" has no content to index.`,
        );
      }

      // Step 6: Generate embeddings (in batches)
      const batchSize = embeddingConfig.batchSize ?? 100;
      const allChunksWithEmbeddings: Array<{
        content: string;
        embedding: number[];
        chunkIndex: number;
        tokenCount: number;
        startPosition: number;
        endPosition: number;
      }> = [];

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map((c) => c.content);

        const embeddingResponse = await embed(
          texts,
          embeddingConfig,
          {},
          context.embeddingProviders,
        );

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const embedding = embeddingResponse.embeddings[j];

          if (!embedding) {
            throw new Error(`Failed to generate embedding for chunk ${i + j}`);
          }

          allChunksWithEmbeddings.push({
            content: chunk.content,
            embedding,
            chunkIndex: chunk.metadata.chunkIndex,
            tokenCount: chunk.metadata.tokenCount,
            startPosition: chunk.metadata.startPosition,
            endPosition: chunk.metadata.endPosition,
          });
        }
      }

      // Step 7: Store chunks as graph nodes with embeddings
      const createdChunks = await ragData.createChunks(
        allChunksWithEmbeddings.map((chunk) => ({
          documentId: document.id,
          namespace,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: chunk.embedding,
          startPosition: chunk.startPosition,
          endPosition: chunk.endPosition,
        })),
      );

      // Link sequential chunks for provenance/navigation.
      const sortedChunks = [...createdChunks].sort((a, b) =>
        a.chunkIndex - b.chunkIndex
      );
      for (let i = 0; i < sortedChunks.length - 1; i++) {
        await ops.mutate.graph.createEdge({
          sourceNodeId: sortedChunks[i].id,
          targetNodeId: sortedChunks[i + 1].id,
          type: GRAPH_EDGE.DERIVED_FROM,
        }, {
          threadId,
          namespace,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
        });
      }

      // Step 8: Update document status
      await ragData.updateDocumentStatus(
        document.id,
        namespace,
        "indexed",
        undefined,
        chunks.length,
      );

      return await createSuccessResponse(
        threadId,
        event,
        deps,
        "RAG",
        `Successfully indexed "${title}" (${chunks.length} chunks).`,
        {
          documentId: document.id,
          title,
          namespace,
          chunks: chunks.length,
          status: "indexed",
        },
      );
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error("[RAG_INGEST] Error:", errorMessage);

      return await createErrorResponse(
        threadId,
        event,
        deps,
        "RAG",
        `Failed to ingest document: ${errorMessage}`,
      );
    }
  },
};

async function createSuccessResponse(
  threadId: string,
  sourceEvent: Event,
  deps: ProcessorDeps,
  senderName: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<{ producedEvents: NewEvent[] }> {
  const eventType = (sourceEvent as unknown as { type?: string }).type;
  if (eventType === "rag_ingestion.created") {
    const payload = {
      content: message,
      sender: { type: "system" as const, name: senderName },
      metadata: {
        skipRouting: true,
        ragResult: data,
      },
    };
    await deps.db.ops.mutate.messages.create(
      {
        threadId,
        senderId: senderName,
        senderType: "system",
        content: message,
        metadata: payload.metadata,
      },
      deps.context.namespace,
      {
        traceId: typeof sourceEvent.traceId === "string"
          ? sourceEvent.traceId
          : null,
        causationId: typeof sourceEvent.id === "string" ? sourceEvent.id : null,
        status: "pending",
        metadata: payload.metadata,
        eventPayload: payload,
      },
    );
    return { producedEvents: [] };
  }
  return {
    producedEvents: [
      {
        threadId,
        type: "NEW_MESSAGE",
        payload: {
          content: message,
          sender: { type: "system", name: senderName },
          metadata: {
            skipRouting: true,
            ragResult: data,
          },
        },
        parentEventId: typeof sourceEvent.id === "string"
          ? sourceEvent.id
          : undefined,
        traceId: typeof sourceEvent.traceId === "string"
          ? sourceEvent.traceId
          : undefined,
        namespace: typeof sourceEvent.namespace === "string"
          ? sourceEvent.namespace
          : undefined,
      },
    ],
  };
}

async function createErrorResponse(
  threadId: string,
  sourceEvent: Event,
  deps: ProcessorDeps,
  senderName: string,
  errorMessage: string,
): Promise<{ producedEvents: NewEvent[] }> {
  const eventType = (sourceEvent as unknown as { type?: string }).type;
  if (eventType === "rag_ingestion.created") {
    const payload = {
      content: `❌ ${errorMessage}`,
      sender: { type: "system" as const, name: senderName },
      metadata: {
        skipRouting: true,
        error: true,
      },
    };
    await deps.db.ops.mutate.messages.create(
      {
        threadId,
        senderId: senderName,
        senderType: "system",
        content: payload.content,
        metadata: payload.metadata,
      },
      deps.context.namespace,
      {
        traceId: typeof sourceEvent.traceId === "string"
          ? sourceEvent.traceId
          : null,
        causationId: typeof sourceEvent.id === "string" ? sourceEvent.id : null,
        status: "pending",
        metadata: payload.metadata,
        eventPayload: payload,
      },
    );
    return { producedEvents: [] };
  }
  return {
    producedEvents: [
      {
        threadId,
        type: "NEW_MESSAGE",
        payload: {
          content: `❌ ${errorMessage}`,
          sender: { type: "system", name: senderName },
          metadata: {
            skipRouting: true,
            error: true,
          },
        },
        parentEventId: typeof sourceEvent.id === "string"
          ? sourceEvent.id
          : undefined,
        traceId: typeof sourceEvent.traceId === "string"
          ? sourceEvent.traceId
          : undefined,
        namespace: typeof sourceEvent.namespace === "string"
          ? sourceEvent.namespace
          : undefined,
      },
    ],
  };
}

export default ragIngestProcessor;

export const { shouldProcess, process } = ragIngestProcessor;
