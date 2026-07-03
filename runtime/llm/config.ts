import type {
  LLMConfig,
  LLMFallbackConfig,
  LLMRuntimeConfig,
  ProviderFallbackConfig,
} from "@/runtime/llm/types.ts";

const DEFAULT_LIMIT_ESTIMATED_INPUT_TOKENS = 150_000;

export function readRuntimeEnvironment(): Record<string, string> {
  try {
    const runtime = globalThis as unknown as {
      Deno?: { env?: { toObject?: () => Record<string, string> } };
      process?: { env?: Record<string, string | undefined> };
    };
    const denoEnv = runtime.Deno?.env?.toObject?.();
    if (denoEnv && typeof denoEnv === "object") return denoEnv;

    const processEnv = runtime.process?.env;
    if (processEnv && typeof processEnv === "object") {
      return Object.fromEntries(
        Object.entries(processEnv).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    // Runtime credentials remain available through explicit security config.
  }
  return {};
}

export function toLLMConfig(
  config?: Partial<LLMRuntimeConfig> | null,
): LLMConfig {
  if (!config || typeof config !== "object") return {};

  const {
    apiKey: _apiKey,
    fallbacks,
    ...rest
  } = config;

  const sanitizedFallbacks = Array.isArray(fallbacks)
    ? fallbacks.map((fallback) => {
      const {
        apiKey: _fallbackApiKey,
        ...safeFallback
      } = fallback as ProviderFallbackConfig;
      return safeFallback as LLMFallbackConfig;
    })
    : undefined;

  return {
    limitEstimatedInputTokens:
      typeof rest.limitEstimatedInputTokens === "number"
        ? rest.limitEstimatedInputTokens
        : DEFAULT_LIMIT_ESTIMATED_INPUT_TOKENS,
    ...rest,
    ...(sanitizedFallbacks ? { fallbacks: sanitizedFallbacks } : {}),
  } as LLMConfig;
}

export function mergeLLMRuntimeConfig(
  baseConfig?: LLMConfig | null,
  ...runtimeConfigs: Array<Partial<LLMRuntimeConfig> | null | undefined>
): LLMRuntimeConfig {
  return Object.assign(
    {},
    baseConfig ?? {},
    ...runtimeConfigs,
  ) as LLMRuntimeConfig;
}

export function resolveProviderApiKey(
  config: LLMRuntimeConfig,
  env: Record<string, string>,
): string | undefined {
  if (config.apiKey) return config.apiKey;

  const provider = config.provider?.toUpperCase();
  if (!provider) {
    return env.LLM_API_KEY || env.OPENAI_API_KEY || env.OPENAI_KEY;
  }

  return env[`${provider}_API_KEY`] ||
    env[`${provider}_KEY`] ||
    env.LLM_API_KEY;
}
