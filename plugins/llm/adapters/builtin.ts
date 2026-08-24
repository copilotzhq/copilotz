import type {
  LlmAdapter,
  LlmBuiltinModelResource,
  LlmBuiltinProvider,
  LlmJsonObject,
  LlmMode,
} from "../contracts.ts";
import type { ProviderFactory } from "../internal/types.ts";
import {
  createProviderAdapter,
  validateBuiltinProviderCall,
} from "./bridge.ts";
import { anthropicProvider } from "./anthropic/protocol.ts";
import { deepseekProvider } from "./deepseek/protocol.ts";
import { geminiProvider } from "./gemini/protocol.ts";
import { groqProvider } from "./groq/protocol.ts";
import { minimaxProvider } from "./minimax/protocol.ts";
import { ollamaProvider } from "./ollama/protocol.ts";
import { openaiProvider } from "./openai/protocol.ts";

const PROVIDERS: Readonly<Record<LlmBuiltinProvider, ProviderFactory>> = Object
  .freeze({
    openai: openaiProvider,
    anthropic: anthropicProvider,
    gemini: geminiProvider,
    groq: groqProvider,
    deepseek: deepseekProvider,
    minimax: minimaxProvider,
    ollama: ollamaProvider,
  });

/** Materializes one already-normalized built-in Model without exposing it. */
export function materializeBuiltinModel(
  resource: LlmBuiltinModelResource,
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
