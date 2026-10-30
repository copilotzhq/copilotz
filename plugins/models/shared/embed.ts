/** Embedding: the model choice resolved (one model only), and its use told. */
import type { Actor, Context, ReadContext } from "../../../runtime/mod.ts";
import { calledBy, type Endpoint, type Usage } from "./provider.ts";
import { adapterFor, type ModelInfo, type ModelRef, resolve, type Resolved } from "./choice.ts";
import { used } from "./use.ts";
import { measure } from "./telemetry.ts";

/** What an embeddings model choice may set, next to `model`. */
export type EmbeddingSettings = {
  /** Shorter vectors, where the model supports it. */
  dimensions?: number;
  options?: Record<string, unknown>;
};

export type EmbeddingRequest = EmbeddingSettings & {
  connection: Endpoint & { model: string };
  info?: ModelInfo;
  input: string[];
  signal?: AbortSignal;
};

/** The vectors, and what they used; `usage.model` names the model. */
export type Embedding = { vectors: number[][]; usage?: Usage & { model?: string } };

export type EmbeddingsAdapter = { embed(request: EmbeddingRequest): Promise<Embedding> };

type Reach = Pick<Context, "resources" | "adapters" | "signal"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
};

/**
 * The model a choice names, checked. One model only: vectors from different
 * models don't compare, so there is no falling back to another.
 */
export function embedder(ctx: Pick<Context, "resources" | "adapters">, model: ModelRef): Resolved {
  const resolved = resolve(ctx.resources, model);
  if (resolved.length > 1) {
    throw Object.assign(
      new Error(
        `An embedder is one model, not a list: vectors from different models don't compare`,
      ),
      { code: "invalid" },
    );
  }
  adapterFor(ctx.adapters, "embeddings", resolved[0]);
  return resolved[0];
}

/** One vector per input, in the same order. */
export async function embed(
  ctx: Reach,
  request: { model: ModelRef; input: string[]; tags?: Record<string, string> },
): Promise<Embedding> {
  const m = embedder(ctx, request.model);
  const { dimensions, options } = m.settings as EmbeddingSettings;
  const call = measure(ctx.metrics, m, "embeddings");
  let embedding: Embedding;
  try {
    embedding = await adapterFor<EmbeddingsAdapter>(ctx.adapters, "embeddings", m).embed({
      connection: { ...calledBy(m.endpoint, ctx), model: m.model },
      dimensions,
      options,
      info: m.info,
      input: request.input,
      signal: ctx.signal,
    });
  } catch (error) {
    call.end(error);
    throw error;
  }
  call.end();
  if (embedding.usage) call.usage(embedding.usage);
  if (!embedding.usage) return embedding;
  await used(ctx, {
    meter: "embeddings",
    subject: m.id,
    catalog: m.catalog,
    quantities: { ...embedding.usage, model: undefined },
    tags: m.tags ? { ...m.tags, ...request.tags } : request.tags,
  });
  return { ...embedding, usage: { ...embedding.usage, model: m.id } };
}
