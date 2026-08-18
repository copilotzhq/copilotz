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

function llmResource(id: string, factory: ProviderFactory): LlmResource {
  return defineLlmProviderResource({
    id,
    type: "llm",
    generate: generateFromFactory(id, factory),
  });
}

export const openaiLlmResource = llmResource("openai", openaiProvider);
export const anthropicLlmResource = llmResource("anthropic", anthropicProvider);
export const geminiLlmResource = llmResource("gemini", geminiProvider);
export const groqLlmResource = llmResource("groq", groqProvider);
export const deepseekLlmResource = llmResource("deepseek", deepseekProvider);
export const ollamaLlmResource = llmResource("ollama", ollamaProvider);
export const minimaxLlmResource = llmResource("minimax", minimaxProvider);

/** Vendor adapters shipped only when corePlugin is installed. */
export const coreLlmResources: readonly LlmResource[] = Object.freeze([
  openaiLlmResource,
  anthropicLlmResource,
  geminiLlmResource,
  groqLlmResource,
  deepseekLlmResource,
  ollamaLlmResource,
  minimaxLlmResource,
]);
