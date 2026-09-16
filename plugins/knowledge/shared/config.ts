import type { ActionContext } from "@copilotz/copilotz/actions";
import type {
  KnowledgeChunkingConfig,
  KnowledgeEmbeddingConfig,
} from "./types.ts";
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

function chunking(
  value: KnowledgeChunkingConfig = {},
): Required<KnowledgeChunkingConfig> {
  const chunkSize = positiveInteger(value.chunkSize, 512, "Chunk size");
  const chunkOverlap = value.chunkOverlap ?? 50;
  if (
    !Number.isSafeInteger(chunkOverlap) || chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    throw new TypeError("Chunk overlap must be at least zero and below size.");
  }
  return ({
    strategy: value.strategy ?? "fixed",
    chunkSize,
    chunkOverlap,
  } as const);
}

function embedding(value: KnowledgeEmbeddingConfig): KnowledgeEmbeddingConfig {
  return ({
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
  } as const);
}

export function knowledgeConfig(context: Pick<ActionContext, "resources">) {
  const config = context.resources.knowledge?.config as {
    embedding?: KnowledgeEmbeddingConfig;
    chunking?: KnowledgeChunkingConfig;
  } | undefined;
  if (!config?.embedding) {
    throw new TypeError("resources.knowledge.config.embedding is required.");
  }
  return {
    embedding: embedding(config.embedding),
    chunking: chunking(config.chunking),
  };
}
