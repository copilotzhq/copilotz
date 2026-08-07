import type { ScopedPluginResources } from "../engine/index.ts";
import type {
  KnowledgeEmbeddingConfig,
  KnowledgeEmbeddingProviderResource,
  KnowledgeEmbeddingResponse,
} from "./types.ts";

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

/** Defines one worker-local embedding provider as an ordinary plugin resource. */
export function defineKnowledgeEmbeddingProvider(
  resource: KnowledgeEmbeddingProviderResource,
): KnowledgeEmbeddingProviderResource {
  const id = required(resource.id, "Embedding provider ID");
  if (resource.type !== "embedding" || typeof resource.embed !== "function") {
    throw new TypeError(`Embedding provider '${id}' is invalid.`);
  }
  return Object.freeze({ id, type: "embedding", embed: resource.embed });
}

export function isKnowledgeEmbeddingProvider(
  value: unknown,
): value is KnowledgeEmbeddingProviderResource {
  return Boolean(
    value && typeof value === "object" &&
      (value as KnowledgeEmbeddingProviderResource).type === "embedding" &&
      typeof (value as KnowledgeEmbeddingProviderResource).id === "string" &&
      typeof (value as KnowledgeEmbeddingProviderResource).embed === "function",
  );
}

function finiteVector(
  value: readonly number[],
  expectedDimensions: number | undefined,
  index: number,
): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Embedding ${index} is empty.`);
  }
  if (value.some((item) => !Number.isFinite(item))) {
    throw new Error(`Embedding ${index} contains a non-finite value.`);
  }
  if (expectedDimensions !== undefined && value.length !== expectedDimensions) {
    throw new Error(
      `Embedding ${index} has ${value.length} dimensions; expected ${expectedDimensions}.`,
    );
  }
  return Object.freeze([...value]);
}

/** Resolves and invokes the configured embedding resource inside the worker. */
export async function embedKnowledgeTexts(
  resources: ScopedPluginResources,
  config: KnowledgeEmbeddingConfig,
  texts: readonly string[],
  options: Readonly<{ signal: AbortSignal; idempotencyKey: string }>,
): Promise<KnowledgeEmbeddingResponse> {
  const id = required(config.provider, "Embedding provider resource ID");
  const candidate = resources.get("providers", id);
  if (!isKnowledgeEmbeddingProvider(candidate)) {
    throw new Error(`Embedding provider resource '${id}' was not found.`);
  }
  const response = await candidate.embed({
    texts: Object.freeze([...texts]),
    ...(config.model?.trim() ? { model: config.model.trim() } : {}),
    ...(config.dimensions === undefined
      ? {}
      : { dimensions: config.dimensions }),
    signal: options.signal,
    idempotencyKey: required(
      options.idempotencyKey,
      "Embedding idempotency key",
    ),
  });
  if (response.embeddings.length !== texts.length) {
    throw new Error(
      `Embedding provider '${id}' returned ${response.embeddings.length} vectors for ${texts.length} inputs.`,
    );
  }
  const dimensions = config.dimensions ?? response.dimensions ??
    response.embeddings[0]?.length;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error(`Embedding provider '${id}' returned invalid dimensions.`);
  }
  const embeddings = Object.freeze(
    response.embeddings.map((vector, index) =>
      finiteVector(vector, dimensions, index)
    ),
  );
  return Object.freeze({
    embeddings,
    model: required(response.model, "Embedding response model"),
    dimensions,
    ...(response.usage ? { usage: Object.freeze({ ...response.usage }) } : {}),
  });
}
