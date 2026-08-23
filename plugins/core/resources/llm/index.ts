import {
  defineLlmProviderResource,
  generateFromFactory,
  type LlmResource,
  type ProviderFactory,
} from "@copilotz/copilotz/llm";
import { anthropicProvider } from "./anthropic/adapter.ts";
import { deepseekProvider } from "./deepseek/adapter.ts";
import { geminiProvider } from "./gemini/adapter.ts";
import { groqProvider } from "./groq/adapter.ts";
import { minimaxProvider } from "./minimax/adapter.ts";
import { ollamaProvider } from "./ollama/adapter.ts";
import { openaiProvider } from "./openai/adapter.ts";

function llmAdapter(id: string, factory: ProviderFactory): LlmResource {
  return defineLlmProviderResource({
    id,
    type: "llm",
    generate: generateFromFactory(id, factory),
  });
}

export const openaiLlmAdapter: LlmResource = llmAdapter(
  "openai",
  openaiProvider,
);
export const anthropicLlmAdapter: LlmResource = llmAdapter(
  "anthropic",
  anthropicProvider,
);
export const geminiLlmAdapter: LlmResource = llmAdapter(
  "gemini",
  geminiProvider,
);
export const groqLlmAdapter: LlmResource = llmAdapter("groq", groqProvider);
export const deepseekLlmAdapter: LlmResource = llmAdapter(
  "deepseek",
  deepseekProvider,
);
export const ollamaLlmAdapter: LlmResource = llmAdapter(
  "ollama",
  ollamaProvider,
);
export const minimaxLlmAdapter: LlmResource = llmAdapter(
  "minimax",
  minimaxProvider,
);

export type CoreLlmAdapters = Readonly<{
  openai: LlmResource;
  anthropic: LlmResource;
  gemini: LlmResource;
  groq: LlmResource;
  deepseek: LlmResource;
  ollama: LlmResource;
  minimax: LlmResource;
}>;

/** First-party LLM Adapter implementations contributed by Core. */
export const coreLlmAdapters: CoreLlmAdapters = Object.freeze({
  openai: openaiLlmAdapter,
  anthropic: anthropicLlmAdapter,
  gemini: geminiLlmAdapter,
  groq: groqLlmAdapter,
  deepseek: deepseekLlmAdapter,
  ollama: ollamaLlmAdapter,
  minimax: minimaxLlmAdapter,
});
