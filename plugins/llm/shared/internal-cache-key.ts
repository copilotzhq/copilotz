import type { ProviderConfig } from "./types.ts";

const INTERNAL_PROMPT_CACHE_KEY = "__copilotzPromptCacheKey";

type InternalProviderConfig = ProviderConfig & {
  [INTERNAL_PROMPT_CACHE_KEY]?: string;
};

async function sha256Hex(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveInternalPromptCacheKey(
  namespace: string,
  threadId: string,
  agentId: string,
): Promise<string> {
  return await sha256Hex([namespace, threadId, agentId]);
}

/**
 * ChatGPT Codex cache identity. Account isolation is intentionally part of the
 * digest; model selection and request content are deliberately absent.
 */
export async function deriveChatGptCodexCacheKey(
  accountId: string,
  namespace: string,
  threadId: string,
  agentId: string,
): Promise<string> {
  return await sha256Hex([accountId, namespace, threadId, agentId]);
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
