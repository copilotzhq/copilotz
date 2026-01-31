/**
 * RAG Context Generator
 * 
 * Generates context from the RAG knowledge base for auto-injection mode.
 * When an agent has ragOptions.mode === "auto", relevant documents are
 * automatically retrieved and injected into the system prompt.
 */

import type { Agent, AgentRagOptions, EmbeddingConfig } from "@/interfaces/index.ts";
import type { DatabaseOperations } from "@/database/operations/index.ts";
import { embed } from "@/connectors/embeddings/index.ts";

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
    embeddingConfig?: EmbeddingConfig;
    threadId?: string;
    userId?: string;
}

/**
 * Default formatting for RAG context injection
 */
function formatRagContext(chunks: RagContextResult["chunks"]): string {
    if (chunks.length === 0) return "";

    const formattedChunks = chunks.map((chunk, index) => {
        const source = chunk.metadata?.sourceUri || chunk.metadata?.title || `Document ${chunk.documentId}`;
        return `[${index + 1}] (Source: ${source}, Relevance: ${(chunk.score * 100).toFixed(1)}%)\n${chunk.content}`;
    }).join("\n\n---\n\n");

    return `## KNOWLEDGE BASE CONTEXT

The following information was retrieved from the knowledge base based on relevance to the current conversation. Use this context to inform your responses when applicable.

${formattedChunks}

---
Note: The above context is provided for reference. If the user's question is unrelated to this context, you may answer based on your general knowledge.`;
}

/**
 * Resolves namespace patterns for an agent
 */
function resolveNamespaces(
    ragOptions: AgentRagOptions,
    threadId?: string,
    userId?: string
): string[] {
    const namespaces = ragOptions.namespaces || ["default"];
    
    return namespaces.map(ns => {
        // Replace dynamic placeholders
        let resolved = ns;
        if (threadId) {
            resolved = resolved.replace("{threadId}", threadId);
        }
        if (userId) {
            resolved = resolved.replace("{userId}", userId);
        }
        return resolved;
    });
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
    options: RagContextOptions
): Promise<RagContextResult> {
    const { agent, query, ops, embeddingConfig, threadId, userId } = options;
    const ragOptions = agent.ragOptions;

    // Return empty if RAG is disabled or not in auto mode
    if (!ragOptions || ragOptions.mode !== "auto") {
        return { context: "", chunks: [], tokenEstimate: 0 };
    }

    // Check if embedding config is available
    if (!embeddingConfig) {
        console.warn(`[rag-context] No embedding config available for agent "${agent.name}". Skipping RAG context.`);
        return { context: "", chunks: [], tokenEstimate: 0 };
    }

    // Resolve namespaces
    const namespaces = resolveNamespaces(ragOptions, threadId, userId);
    const limit = ragOptions.autoInjectLimit ?? 5;

    try {
        // Generate embedding for the query
        const embeddingResult = await embed([query], embeddingConfig);

        if (!embeddingResult.embeddings || embeddingResult.embeddings.length === 0) {
            console.warn(`[rag-context] Failed to generate embedding for query`);
            return { context: "", chunks: [], tokenEstimate: 0 };
        }

        const queryEmbedding = embeddingResult.embeddings[0];
        if (!queryEmbedding) {
            return { context: "", chunks: [], tokenEstimate: 0 };
        }

        // Search for relevant chunks across all namespaces
        const allResults: RagContextResult["chunks"] = [];

        for (const namespace of namespaces) {
            const results = await ops.searchChunks({
                namespaces: [namespace],
                embedding: queryEmbedding,
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

