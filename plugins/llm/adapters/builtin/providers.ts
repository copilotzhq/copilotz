/** Built-in wire protocols shared by admission, formatting and execution. @module */
import type { LlmBuiltinProvider } from "../../shared/contracts.ts";
import type { ProviderFactory } from "../../shared/types.ts";
import { anthropicProvider } from "../anthropic/index.ts";
import { deepseekProvider } from "../deepseek/index.ts";
import { geminiProvider } from "../gemini/index.ts";
import { groqProvider } from "../groq/index.ts";
import { minimaxProvider } from "../minimax/index.ts";
import { ollamaProvider } from "../ollama/index.ts";
import { openaiProvider } from "../openai/index.ts";

export const builtinProviders: Readonly<
  Record<LlmBuiltinProvider, ProviderFactory>
> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  deepseek: deepseekProvider,
  minimax: minimaxProvider,
  ollama: ollamaProvider,
};
