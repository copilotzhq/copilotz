/** Already-linked ChatGPT authentication, with application-owned account storage. @module */
import type {
  LlmAuthResolution,
  LlmConnectionContext,
  LlmConnectionExecution,
  LlmConnectionResource,
} from "../../shared/contracts.ts";

export type ChatGptTokens = Readonly<{
  accessToken: string;
  refreshToken?: string;
  /** Expiry in milliseconds since the Unix epoch. */
  expiresAt: number;
}>;

/** Ephemeral decrypted snapshot. `version` identifies its stored token revision. */
export type ChatGptAccount =
  & ChatGptTokens
  & Readonly<{
    id: string;
    accountId: string;
    version: string;
  }>;

type MaybePromise<T> = T | Promise<T>;
export type ChatGptConnectionOptions = Readonly<{
  oauth: Readonly<{ clientId: string }>;
  load(context: LlmConnectionContext): MaybePromise<ChatGptAccount | null>;
  /** Conditionally replace `previous`; return the stored winner, or null if disconnected. */
  save(
    context: LlmConnectionContext,
    previous: ChatGptAccount,
    tokens: ChatGptTokens,
  ): MaybePromise<ChatGptAccount | null>;
  /** Conditionally expire `previous`; return a usable replacement if another writer won. */
  markExpired(
    context: LlmConnectionContext,
    previous: ChatGptAccount,
  ): MaybePromise<ChatGptAccount | null>;
  fetch?: typeof fetch;
  now?: () => number;
}>;

const unavailable = { available: false as const } as const;
const skewMs = 60_000;
const refreshTimeoutMs = 30_000;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function account(value: ChatGptAccount | null): ChatGptAccount | null {
  if (value === null) return null;
  if (
    !value || !nonempty(value.id) || !nonempty(value.accountId) ||
    !nonempty(value.version) || !nonempty(value.accessToken) ||
    !Number.isFinite(value.expiresAt) ||
    (value.refreshToken !== undefined && !nonempty(value.refreshToken))
  ) throw new Error("Invalid ChatGPT account snapshot.");
  return ({ ...value } as const);
}

function fresh(
  value: ChatGptAccount | null,
  now: number,
): boolean {
  return value !== null && value.expiresAt > now + skewMs;
}

function credentials(
  value: ChatGptAccount | null,
  now: number,
): LlmAuthResolution {
  return value !== null && fresh(value, now)
    ? ({
      available: true,
      apiKey: value.accessToken,
      extraHeaders: { "ChatGPT-Account-ID": value.accountId } as const,
    } as const)
    : unavailable;
}

/** Cancel one waiter without losing another caller's in-flight token rotation. */
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(new DOMException("Authentication cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/**
 * Builds a process-local connection, never an Action input. The caller supplies
 * its OAuth registration and trusted account storage; this helper does not log
 * tokens, select users, encrypt storage, or implement initial account linking.
 */
export function createChatGptConnection(
  options: ChatGptConnectionOptions,
): LlmConnectionResource {
  if (!nonempty(options.oauth?.clientId)) {
    throw new TypeError("ChatGPT OAuth clientId is required.");
  }
  const clientId = options.oauth.clientId;
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  // Per connection instance and tenant/account revision, never a global auth cache.
  const refreshing = new Map<string, Promise<ChatGptAccount | null>>();

  async function refresh(
    context: LlmConnectionContext,
    previous: ChatGptAccount,
  ): Promise<ChatGptAccount | null> {
    if (!previous.refreshToken) return null;
    const response = await request("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: previous.refreshToken,
      }),
      signal: context.signal,
      redirect: "error",
    });
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid ChatGPT refresh response.");
    }
    const data = payload as Record<string, unknown>;
    if (!response.ok) {
      // Rate limits, outages, and client configuration errors must not revoke accounts.
      if (data.error !== "invalid_grant") return null;
      const current = account(await options.load(context));
      if (
        !current || current.id !== previous.id ||
        current.accountId !== previous.accountId
      ) return null;
      if (current.version !== previous.version) return current;
      return account(await options.markExpired(context, previous));
    }
    if (
      !nonempty(data.access_token) ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      (data.refresh_token !== undefined && !nonempty(data.refresh_token))
    ) throw new Error("Invalid ChatGPT refresh response.");
    const expiresAt = now() + data.expires_in * 1_000;
    if (!Number.isFinite(expiresAt)) {
      throw new Error("Invalid ChatGPT token expiry.");
    }
    const refreshToken = data.refresh_token as string | undefined ??
      previous.refreshToken;
    return account(
      await options.save(
        context,
        previous,
        {
          accessToken: data.access_token,
          ...(refreshToken === undefined ? {} : { refreshToken }),
          expiresAt,
        } as const,
      ),
    );
  }

  return ({
    provider: "openai" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    runtimeDiagnostics: {
      enabled: true,
      credentialSource: "connected_account" as const,
    } as const,
    auth: {
      async resolve(
        context: LlmConnectionContext,
        execution: LlmConnectionExecution,
      ): Promise<LlmAuthResolution> {
        context.signal.throwIfAborted();
        try {
          const previous = account(
            await wait(Promise.resolve(options.load(context)), context.signal),
          );
          if (!previous) return unavailable;
          if (fresh(previous, now())) return credentials(previous, now());
          const key = JSON.stringify([
            context.namespace,
            execution.connection,
            previous.id,
            previous.version,
          ]);
          let pending = refreshing.get(key);
          if (!pending) {
            // A detached waiter must not discard rotated tokens. Shared refresh has
            // its own bounded lifetime and may finish its conditional storage write.
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(),
              refreshTimeoutMs,
            );
            const sharedContext = {
              ...context,
              signal: controller.signal,
            } as const;
            pending = wait(refresh(sharedContext, previous), controller.signal)
              .catch(() => null)
              .finally(() => {
                clearTimeout(timeout);
                if (refreshing.get(key) === pending) refreshing.delete(key);
              });
            refreshing.set(key, pending);
          }
          const stored = await wait(pending, context.signal);
          // Never reuse credentials for a changed provider-account identity.
          return stored !== null && stored.id === previous.id &&
              stored.accountId === previous.accountId
            ? credentials(stored, now())
            : unavailable;
        } catch {
          context.signal.throwIfAborted();
          // Callback/provider exceptions may contain decrypted OAuth material.
          return unavailable;
        }
      },
    } as const,
  } as const);
}
