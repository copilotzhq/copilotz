/**
 * RAG Context Generator
 *
 * Generates context from the RAG knowledge base for auto-injection mode.
 * When an agent has ragOptions.mode === "auto", relevant documents are
 * automatically retrieved and injected into the system prompt.
 */

import type { Agent, AgentRagOptions, EmbeddingConfig } from "@/types/index.ts";
import type { DatabaseOperations } from "@/database/operations/index.ts";
import { createRagDataServices } from "@/runtime/collections/native.ts";

export interface RagContextResult {
  context: string;
  chunks: Array<{
    id: string;
    documentId: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  tokenEstimate: number;
}

export interface RagContextOptions {
  agent: Agent;
  query: string;
  ops: DatabaseOperations;
  collections?: import("@/types/index.ts").ChatContext["collections"];
  embeddingConfig?: EmbeddingConfig;
  embeddingProviders?:
    import("@/types/index.ts").ChatContext["embeddingProviders"];
  namespace?: string;
  threadId?: string;
  userId?: string;
}

/**
 * Default formatting for RAG context injection
 */
function formatRagContext(chunks: RagContextResult["chunks"]): string {
  if (chunks.length === 0) return "";

  const formattedChunks = chunks.map((chunk, index) => {
    const source = chunk.metadata?.sourceUri || chunk.metadata?.title ||
      `Document ${chunk.documentId}`;
    return `[${index + 1}] (Source: ${source}, Relevance: ${
      (chunk.score * 100).toFixed(1)
    }%)\n${chunk.content}`;
  }).join("\n\n---\n\n");

  return `## KNOWLEDGE BASE CONTEXT

The following information was retrieved from the knowledge base based on relevance to the current conversation. Use this context to inform your responses when applicable.

${formattedChunks}

---
Note: The above context is provided for reference. If the user's question is unrelated to this context, you may answer based on your general knowledge.`;
}

/**
 * Estimates token count for a string (rough approximation)
 * Uses ~4 characters per token as a simple heuristic
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generates RAG context for auto-injection into LLM calls
 */
export async function generateRagContext(
  options: RagContextOptions,
): Promise<RagContextResult> {
  const {
    agent,
    query,
    ops,
    collections,
    embeddingConfig,
    embeddingProviders,
    namespace,
    threadId,
  } = options;
  const ragOptions = agent.ragOptions;

  // Return empty if RAG is disabled or not in auto mode
  if (!ragOptions || ragOptions.mode !== "auto") {
    return { context: "", chunks: [], tokenEstimate: 0 };
  }

  // Check if embedding config is available
  if (!embeddingConfig) {
    console.warn(
      `[rag-context] No embedding config available for agent "${agent.name}". Skipping RAG context.`,
    );
    return { context: "", chunks: [], tokenEstimate: 0 };
  }

  if (!namespace) {
    console.warn(
      `[rag-context] No tenant namespace available for agent "${agent.name}". Skipping RAG context.`,
    );
    return { context: "", chunks: [], tokenEstimate: 0 };
  }

  const limit = ragOptions.autoInjectLimit ?? 5;

  try {
    const ragData = createRagDataServices({ collections, ops });
    const allResults: RagContextResult["chunks"] = [];

    const results = await ragData.searchChunks({
      namespace,
      scope: {
        threadId,
        agentId: agent.id ?? agent.name,
        ...ragOptions.scope,
      },
      query,
      limit,
      threshold: 0.5, // Configurable threshold
    });

    for (const result of results) {
      allResults.push({
        id: result.id,
        documentId: result.document?.id || "",
        content: result.content,
        score: result.similarity,
        metadata: result.metadata as Record<string, unknown> | undefined,
      });
    }

    // Sort by score and take top results
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, limit);

    if (topResults.length === 0) {
      return { context: "", chunks: [], tokenEstimate: 0 };
    }

    // Format the context
    const context = formatRagContext(topResults);
    const tokenEstimate = estimateTokens(context);

    return {
      context,
      chunks: topResults,
      tokenEstimate,
    };
  } catch (error) {
    console.error(`[rag-context] Error generating RAG context:`, error);
    return { context: "", chunks: [], tokenEstimate: 0 };
  }
}
