/** OpenAI embeddings, and every OpenAI-compatible provider's: POST /embeddings. */
import { post } from "../../shared/provider.ts";
import { OPENAI } from "../llm/openai-compatible.ts";
import type { EmbeddingsAdapter } from "../../shared/embed.ts";

export const openai: EmbeddingsAdapter = {
  async embed({ connection, dimensions, options, input, signal }) {
    const response = await post(connection, OPENAI, "/embeddings", {
      model: connection.model,
      input,
      ...(dimensions ? { dimensions } : {}),
      ...options,
    }, signal);
    const body = await response.json() as {
      data: { index: number; embedding: number[] }[];
      usage?: { prompt_tokens?: number };
    };
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return {
      vectors,
      ...(body.usage?.prompt_tokens !== undefined
        ? { usage: { input: body.usage.prompt_tokens, output: 0 } }
        : {}),
    };
  },
};
