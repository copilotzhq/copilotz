import type {
  ProviderConfig,
  ProviderFallbackConfig,
} from "@/runtime/llm/types.ts";

export interface OpenAIPromptCacheScope {
  namespace: string;
  threadId: string;
  agentId: string;
}

function isChatGPTCodexTransport(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      (
        url.pathname.replace(/\/+$/, "") === "/backend-api/codex" ||
        url.pathname.startsWith("/backend-api/codex/")
      );
  } catch {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createOpenAIPromptCacheKey(
  scope: OpenAIPromptCacheScope,
  model: string | undefined,
): Promise<string> {
  return await sha256Hex(JSON.stringify([
    "copilotz",
    1,
    scope.namespace,
    scope.threadId,
    scope.agentId,
    model ?? "default",
  ]));
}

/**
 * Adds stable OpenAI routing keys without overriding caller-supplied keys.
 *
 * Fallbacks receive model-specific keys because their effective model may
 * differ from the primary attempt. Non-OpenAI attempts ignore this setting.
 */
export async function withAutomaticOpenAIPromptCacheKeys(
  config: ProviderConfig,
  scope: OpenAIPromptCacheScope,
): Promise<ProviderConfig> {
  const explicitlyConfiguredKey = typeof config.openaiPromptCacheKey ===
        "string" && config.openaiPromptCacheKey.trim().length > 0
    ? config.openaiPromptCacheKey
    : undefined;
  const primaryKey = config.provider === "openai" &&
      !isChatGPTCodexTransport(config.baseUrl) &&
      !explicitlyConfiguredKey
    ? await createOpenAIPromptCacheKey(scope, config.model)
    : explicitlyConfiguredKey;

  const fallbacks = await Promise.all(
    (config.fallbacks ?? []).map(
      async (fallback): Promise<ProviderFallbackConfig> => {
        if (fallback.provider !== "openai") return fallback;
        let fallbackKey = typeof fallback.openaiPromptCacheKey === "string" &&
            fallback.openaiPromptCacheKey.trim().length > 0
          ? fallback.openaiPromptCacheKey
          : explicitlyConfiguredKey;
        const effectiveBaseUrl = "baseUrl" in fallback
          ? fallback.baseUrl
          : config.baseUrl;
        if (!fallbackKey && !isChatGPTCodexTransport(effectiveBaseUrl)) {
          fallbackKey = await createOpenAIPromptCacheKey(
            scope,
            fallback.model ?? config.model,
          );
        }
        return {
          ...fallback,
          ...(fallbackKey ? { openaiPromptCacheKey: fallbackKey } : {}),
        };
      },
    ),
  );

  return {
    ...config,
    ...(primaryKey ? { openaiPromptCacheKey: primaryKey } : {}),
    ...(config.fallbacks ? { fallbacks } : {}),
  };
}
