import type {
  ChatMessage,
  ProviderAPI,
  ProviderConfig,
  ProviderFinishReason,
  ProviderUsageUpdate,
  StreamCallback,
} from "@/runtime/llm/types.ts";
import { LLMStreamTimeoutError } from "@/runtime/llm/errors.ts";
import { getLocalStopSequences, processStream } from "@/runtime/llm/utils.ts";
import { streamPost, type StreamResponse } from "@/runtime/http.ts";

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 20_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5_000;

export interface StreamResult {
  content: string;
  reasoning: string;
  usage?: ProviderUsageUpdate;
  usageFinalized?: Promise<{
    usage?: ProviderUsageUpdate;
    finishReason: ProviderFinishReason | null;
  }>;
  finishReason: ProviderFinishReason | null;
  stoppedByLocalStop: boolean;
  localStopReason?: "local_stop_sequence";
  localStopSequence?: string;
}

function resolveTimeoutMs(
  value: number | undefined,
  defaultValue: number,
): number | undefined {
  if (value === undefined) return defaultValue;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Executes a single LLM provider streaming call with timeout management.
 */
export async function runProviderStream(
  messages: ChatMessage[],
  onStream: StreamCallback | undefined,
  config: ProviderConfig,
  providerAPI: ProviderAPI,
  extractTags?: string[],
  signal?: AbortSignal,
): Promise<StreamResult> {
  const localStopSequences = getLocalStopSequences(config);
  const finalMessages = providerAPI.transformMessages
    ? providerAPI.transformMessages(messages)
    : messages;

  // Stop sequences are always enforced client-side in `processStream`. We also
  // forward the resolved set to providers with native stop support (Anthropic,
  // Gemini, MiniMax) via `nativeStopSequences` so they can halt server-side and
  // avoid generating tokens we would otherwise discard. The public `stop`/
  // `stopSequences` fields stay stripped so providers without opt-in handling
  // (e.g. OpenAI's 4-stop limit) are unaffected.
  const requestConfig = {
    ...config,
    stop: undefined,
    stopSequences: undefined,
    nativeStopSequences: localStopSequences.length > 0
      ? localStopSequences
      : undefined,
  } satisfies ProviderConfig;

  const abortController = new AbortController();
  const firstTokenTimeoutMs = resolveTimeoutMs(
    config.firstTokenTimeoutMs,
    DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  );
  const streamIdleTimeoutMs = resolveTimeoutMs(
    config.streamIdleTimeoutMs,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );

  let firstTokenTimer: number | undefined;
  let streamIdleTimer: number | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamTimeout:
    | { kind: "first_token" | "idle"; timeoutMs: number }
    | undefined;
  let firstContentReceived = false;

  const clearFirstTokenTimer = () => {
    if (firstTokenTimer !== undefined) {
      clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    }
  };
  const clearStreamIdleTimer = () => {
    if (streamIdleTimer !== undefined) {
      clearTimeout(streamIdleTimer);
      streamIdleTimer = undefined;
    }
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  const abortForTimeout = (
    kind: "first_token" | "idle",
    timeoutMs: number,
  ) => {
    if (streamTimeout) return;
    streamTimeout = { kind, timeoutMs };
    abortController.abort();
    void reader?.cancel().catch(() => undefined);
    rejectTimeout?.(new LLMStreamTimeoutError(kind, timeoutMs));
  };
  const abortForExternalSignal = () => {
    abortController.abort();
    void reader?.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    abortForExternalSignal();
  }
  signal?.addEventListener("abort", abortForExternalSignal, { once: true });

  const startFirstTokenTimer = () => {
    if (!firstTokenTimeoutMs) return;
    clearFirstTokenTimer();
    firstTokenTimer = setTimeout(() => {
      abortForTimeout("first_token", firstTokenTimeoutMs);
    }, firstTokenTimeoutMs) as unknown as number;
  };

  const resetStreamIdleTimer = () => {
    if (!streamIdleTimeoutMs || !firstContentReceived) return;
    clearStreamIdleTimer();
    streamIdleTimer = setTimeout(() => {
      abortForTimeout("idle", streamIdleTimeoutMs);
    }, streamIdleTimeoutMs) as unknown as number;
  };

  // Provider is alive (metadata events) — reset the first-token timer
  // to extend the deadline, but don't switch to idle mode yet.
  const recordStreamActivity = () => {
    if (!firstContentReceived) {
      startFirstTokenTimer();
    }
    resetStreamIdleTimer();
  };

  // Actual content extracted — switch from first-token to idle mode.
  const recordContentReceived = () => {
    if (!firstContentReceived) {
      firstContentReceived = true;
      clearFirstTokenTimer();
    }
    resetStreamIdleTimer();
  };

  startFirstTokenTimer();
  try {
    const response = await Promise.race([
      streamPost(
        providerAPI.endpoint,
        await providerAPI.body(
          Array.isArray(finalMessages) ? finalMessages : messages,
          requestConfig,
        ),
        {
          headers: providerAPI.headers(requestConfig),
          signal: abortController.signal,
        },
      ) as Promise<StreamResponse>,
      timeoutPromise,
    ]);

    reader = response.stream.getReader();
    const streamPromise = processStream(
      reader,
      onStream || (() => {}),
      (data) => {
        if (providerAPI.isStreamActivity?.(data)) {
          recordStreamActivity();
        }
        const parts = providerAPI.extractContent(data);
        if (parts) {
          const hasVisibleContent = parts.some(
            (p) =>
              typeof p.text === "string" && p.text.length > 0 && !p.isReasoning,
          );
          if (hasVisibleContent) {
            recordContentReceived();
          } else if (
            parts.some(
              (p) => typeof p.text === "string" && p.text.length > 0,
            )
          ) {
            // Reasoning-only tokens: model is working, extend the first-token
            // deadline but don't switch to idle mode.
            recordStreamActivity();
          }
        }
        return parts;
      },
      {
        ...providerAPI.streamOptions,
        config,
        extractedBlockTags: extractTags,
        extractUsage: providerAPI.extractUsage,
        extractFinishReason: providerAPI.extractFinishReason,
        localStopSequences,
        continueAfterLocalStop: true,
      },
    );
    return await Promise.race([streamPromise, timeoutPromise]);
  } catch (error) {
    if (streamTimeout) {
      throw new LLMStreamTimeoutError(
        streamTimeout.kind,
        streamTimeout.timeoutMs,
      );
    }
    throw error;
  } finally {
    clearFirstTokenTimer();
    clearStreamIdleTimer();
    signal?.removeEventListener("abort", abortForExternalSignal);
  }
}
