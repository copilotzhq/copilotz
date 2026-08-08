import { anthropicProvider } from "../llm/providers/anthropic/adapter.ts";
import { deepseekProvider } from "../llm/providers/deepseek/adapter.ts";
import { geminiProvider } from "../llm/providers/gemini/adapter.ts";
import { groqProvider } from "../llm/providers/groq/adapter.ts";
import { minimaxProvider } from "../llm/providers/minimax/adapter.ts";
import { ollamaProvider } from "../llm/providers/ollama/adapter.ts";
import { openaiProvider } from "../llm/providers/openai/adapter.ts";
import type { ProviderFactory } from "../llm/types.ts";
import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import { defineLlmProviderResource } from "./resources.ts";

export type BuiltInLlmProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepseek"
  | "ollama"
  | "minimax";

const BUILT_IN_PROVIDER_FACTORIES: Readonly<
  Record<BuiltInLlmProviderId, ProviderFactory>
> = Object.freeze(
  {
    openai: openaiProvider,
    anthropic: anthropicProvider,
    gemini: geminiProvider,
    groq: groqProvider,
    deepseek: deepseekProvider,
    ollama: ollamaProvider,
    minimax: minimaxProvider,
  } satisfies Readonly<Record<string, ProviderFactory>>,
);

export type CreateBuiltInLlmProvidersPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly BuiltInLlmProviderId[];
}>;

/** Packages the bundled low-level provider factories as ordinary resources. */
export function createBuiltInLlmProvidersPlugin(
  options: CreateBuiltInLlmProvidersPluginOptions = {},
): CopilotzPlugin {
  const ids = options.include
    ? [...new Set(options.include)]
    : Object.keys(BUILT_IN_PROVIDER_FACTORIES) as BuiltInLlmProviderId[];
  const providers = Object.freeze(ids.map((id) => {
    const factory = BUILT_IN_PROVIDER_FACTORIES[id];
    if (!factory) throw new TypeError(`Unknown built-in LLM provider '${id}'.`);
    return defineLlmProviderResource({ id, type: "llm", factory });
  }));
  return definePlugin({
    manifest: {
      id: options.id ?? "@copilotz/built-in-llm-providers",
      version: options.version ?? "3.0.0",
      provides: { providers: providers.map((provider) => provider.id) },
    },
    resources: { providers },
  });
}
