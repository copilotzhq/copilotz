import { assert } from "@std/assert";
import { defineKnowledgeEmbeddingProvider } from "./index.ts";

Deno.test("embedding resource freezes a valid provider", () => {
  const provider = defineKnowledgeEmbeddingProvider({
    id: "fixture",
    type: "embedding",
    async embed() {
      return { embeddings: [[1]], model: "fixture", dimensions: 1 };
    },
  });
  assert(Object.isFrozen(provider));
});
