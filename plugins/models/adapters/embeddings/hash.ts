/**
 * Offline embeddings for tests and demos: each word (lowercased, with a crude
 * plural stripped) adds to a few dimensions picked by its hash, so texts that
 * share words have similar vectors. No meaning beyond word overlap.
 */
import type { EmbeddingsAdapter } from "../../shared/embed.ts";

const words = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2)
    .map((word) => word.length > 4 ? word.replace(/s$/, "") : word);

function hash(word: string, seed: number) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const hashEmbeddings: EmbeddingsAdapter = {
  embed({ dimensions = 256, input }) {
    const vectors = input.map((text) => {
      const vector = new Array<number>(dimensions).fill(0);
      for (const word of words(text)) {
        for (let k = 0; k < 3; k++) vector[hash(word, k) % dimensions] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((x) => x / norm);
    });
    // Nothing to pay for: no tokens counted.
    return Promise.resolve({ vectors, usage: { input: 0, output: 0 } });
  },
};
