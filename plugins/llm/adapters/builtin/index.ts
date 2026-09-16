/** Built-in provider Adapter materialization. @module */

import type {
  LlmAdapter,
  LlmBuiltinProvider,
  LlmBuiltinProviderConfiguration,
  LlmJsonObject,
  LlmMode,
} from "../../internal/contracts.ts";
import type { ProviderFactory } from "../../internal/types.ts";
import {
  createProviderAdapter,
  validateBuiltinProviderCall,
} from "../bridge/index.ts";
import { anthropicProvider } from "../anthropic/index.ts";
import { deepseekProvider } from "../deepseek/index.ts";
import { geminiProvider } from "../gemini/index.ts";
import { groqProvider } from "../groq/index.ts";
import { minimaxProvider } from "../minimax/index.ts";
import { ollamaProvider } from "../ollama/index.ts";
import { openaiProvider } from "../openai/index.ts";

const PROVIDERS: Readonly<Record<LlmBuiltinProvider, ProviderFactory>> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  deepseek: deepseekProvider,
  minimax: minimaxProvider,
  ollama: ollamaProvider,
} as const;

/** Materializes one resolved built-in provider configuration without exposing it. */
export function materializeBuiltinModel(
  resource: LlmBuiltinProviderConfiguration,
  mode: LlmMode,
  options: LlmJsonObject,
): LlmAdapter {
  validateBuiltinProviderCall(resource.provider, mode, options);
  return createProviderAdapter(
    resource.provider,
    resource,
    PROVIDERS[resource.provider],
  );
}
