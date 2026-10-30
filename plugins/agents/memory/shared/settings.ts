/** Memory's settings (the `memory` resource, which an app patches), and its embedding cache. */
import type { Context, ReadContext, Resources } from "../../../../runtime/mod.ts";
import type { Embedding as Vectors, ModelRef } from "../../../models/contract.ts";

export type MemorySettings = {
  /** An embeddings model (`"provider/model"`, …), for semantic recall; without one, recall matches words. */
  embedder?: ModelRef;
  /** A model (`"provider/model"`, …) that extracts memories from conversations on its own. */
  extractor?: ModelRef;
  /** Shared messages per extraction (8). */
  every?: number;
  /** The agents with memory (all by default). */
  agents?: string[];
};

/** Memory's settings, as configured. */
export const settingsOf = (ctx: { resources: Resources }): MemorySettings =>
  (ctx.resources.memory ?? {}) as MemorySettings;

/** Whether `agent` has memory. */
export const applies = (ctx: { resources: Resources }, agent: string) => {
  const { agents } = settingsOf(ctx);
  return !agents || agents.includes(agent);
};

/** What embedding reaches: the configuration, and Actions to call (a job's, a query's, a View's). */
type Embedding = Pick<Context, "resources"> & { call: ReadContext["call"] };

/**
 * Embeddings of texts already seen, per runtime (its resources) and model: a
 * turn re-renders, and its latest message repeats.
 */
const caches = new WeakMap<object, Map<string, number[]>>();

/** Vectors for texts, or undefined without an embedder. */
export async function vectors(ctx: Embedding, texts: string[]): Promise<number[][] | undefined> {
  const { embedder } = settingsOf(ctx);
  if (!embedder) return undefined;
  let seen = caches.get(ctx.resources);
  if (!seen) caches.set(ctx.resources, seen = new Map());
  const model = JSON.stringify(embedder);
  const key = (text: string) => `${model}\n${text}`;
  const missing = [...new Set(texts.filter((text) => !seen.has(key(text))))];
  if (missing.length) {
    const { vectors } = await ctx.call<Vectors>("embeddings.embed", {
      model: embedder,
      input: missing,
      tags: { purpose: "memory" },
    });
    missing.forEach((text, i) => seen.set(key(text), vectors[i]));
    while (seen.size > 1_000) seen.delete(seen.keys().next().value!);
  }
  return texts.map((text) => seen.get(key(text))!);
}
