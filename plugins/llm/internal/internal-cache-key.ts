import type { ProviderConfig } from "./types.ts";

const INTERNAL_PROMPT_CACHE_KEY = "__copilotzPromptCacheKey";

type InternalProviderConfig = ProviderConfig & {
  [INTERNAL_PROMPT_CACHE_KEY]?: string;
};

export async function deriveInternalPromptCacheKey(
  namespace: string,
  threadId: string,
  agentId: string,
): Promise<string> {
  const source = JSON.stringify([namespace, threadId, agentId]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function withInternalPromptCacheKey(
  config: ProviderConfig,
  key: string,
): ProviderConfig {
  return {
    ...config,
    [INTERNAL_PROMPT_CACHE_KEY]: key,
  } as InternalProviderConfig;
}

export function readInternalPromptCacheKey(
  config: ProviderConfig,
): string | undefined {
  const key = (config as InternalProviderConfig)[INTERNAL_PROMPT_CACHE_KEY];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

export function stripInternalPromptCacheKey(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...config };
  delete copy[INTERNAL_PROMPT_CACHE_KEY];
  return copy;
}
