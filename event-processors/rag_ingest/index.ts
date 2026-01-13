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
} from "@/interfaces/index.ts";
import type { RagIngestPayload } from "@/database/schemas/index.ts";

import { fetchDocument, preprocessContent } from "@/utils/document-fetcher.ts";
import { chunkText, hashContentSHA256 } from "@/utils/chunker.ts";
import { embed } from "@/connectors/embeddings/index.ts";

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

export const ragIngestProcessor: EventProcessor<RagIngestPayload, ProcessorDeps> = {
  shouldProcess: (event: Event) => {
    // RAG_INGEST is a custom event type
    const eventType = (event as unknown as { type: string }).type;
    const eventPayload = (event as unknown as { payload: unknown }).payload;
    return eventType === "RAG_INGEST" && isRagIngestPayload(eventPayload);
  },

  process: async (event: Event, deps: ProcessorDeps) => {
    const { db, thread, context } = deps;
    const ops = db.ops;
    const payload = (event as unknown as { payload: RagIngestPayload }).payload;

    const eventThreadId = (event as unknown as { threadId?: string }).threadId;
    const threadId: string = typeof eventThreadId === "string" ? eventThreadId : String(thread.id);

    const {
      source,
      title: providedTitle,
      namespace = "default",
      metadata = {},
      forceReindex = false,
    } = payload;

    // Get embedding config from context
    const embeddingConfig = context.embeddingConfig ?? context.ragConfig?.embedding;
    if (!embeddingConfig) {
      return createErrorResponse(threadId, event, "RAG", 
        "Embedding configuration not available. Ensure RAG is enabled in copilotz config.");
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
      const processedContent = preprocessContent(fetchedDoc.content, fetchedDoc.mimeType);

      // Step 3: Calculate hash for deduplication
      const contentHash = await hashContentSHA256(processedContent);

      // Check for existing document with same hash
      if (!forceReindex) {
        const existing = await ops.getDocumentByHash(contentHash, namespace) as DocumentRecord | undefined;
        if (existing && existing.status === "indexed") {
          return createSuccessResponse(threadId, event, "RAG",
            `Document "${title}" already indexed (hash: ${contentHash.slice(0, 8)}...).`,
            { documentId: existing.id, status: "skipped" });
        }

        // If existing but failed, delete and reindex
        if (existing) {
          await ops.deleteDocument(existing.id);
        }
      }

      // Step 4: Create document record
      const document = await ops.createDocument({
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
        await ops.updateDocumentStatus(document.id, "failed", "No content to index");
        return createErrorResponse(threadId, event, "RAG",
          `Document "${title}" has no content to index.`);
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

        const embeddingResponse = await embed(texts, embeddingConfig);

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

      // Step 7: Store chunks with embeddings
      await ops.createChunks(
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

      // Step 8: Update document status
      await ops.updateDocumentStatus(document.id, "indexed", undefined, chunks.length);

      return createSuccessResponse(threadId, event, "RAG",
        `Successfully indexed "${title}" (${chunks.length} chunks) into namespace "${namespace}".`,
        {
          documentId: document.id,
          title,
          namespace,
          chunks: chunks.length,
          status: "indexed",
        });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[RAG_INGEST] Error:", errorMessage);

      return createErrorResponse(threadId, event, "RAG",
        `Failed to ingest document: ${errorMessage}`);
    }
  },
};

function createSuccessResponse(
  threadId: string,
  sourceEvent: Event,
  senderName: string,
  message: string,
  data?: Record<string, unknown>,
): { producedEvents: NewEvent[] } {
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
        parentEventId: typeof sourceEvent.id === "string" ? sourceEvent.id : undefined,
        traceId: typeof sourceEvent.traceId === "string" ? sourceEvent.traceId : undefined,
      },
    ],
  };
}

function createErrorResponse(
  threadId: string,
  sourceEvent: Event,
  senderName: string,
  errorMessage: string,
): { producedEvents: NewEvent[] } {
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
        parentEventId: typeof sourceEvent.id === "string" ? sourceEvent.id : undefined,
        traceId: typeof sourceEvent.traceId === "string" ? sourceEvent.traceId : undefined,
      },
    ],
  };
}

export default ragIngestProcessor;

