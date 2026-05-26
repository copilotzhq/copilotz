import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderFallbackReason,
  ProviderFinishReason,
  ProviderName,
  StreamCallback,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { estimateUsageCost } from "@/runtime/llm/pricing.ts";
import { resolveProviderApiKey, toLLMConfig } from "@/runtime/llm/config.ts";
import {
  COPILOTZ_CONTROL_TAGS,
  countTokens,
  createMockResponse,
  estimateUsage,
  findDanglingControlTags,
  formatMessages,
  getLocalStopSequences,
  parseInternalControlTagsFromResponse,
  parseTaggedBlocksFromResponse,
  parseToolCallsFromResponse,
  processStream,
  stripDanglingControlTail,
  withDefaultStopSequences,
} from "@/runtime/llm/utils.ts";
import { streamPost, type StreamResponse } from "@/runtime/http.ts";
import type {
  ProviderRegistry,
  ProviderUsageUpdate,
  TokenUsage,
} from "@/runtime/llm/types.ts";

const DEFAULT_FALLBACK_REASONS: ProviderFallbackReason[] = [
  "timeout",
  "network",
  "auth_error",
  "rate_limit",
  "server_error",
  "provider_error",
  "unknown",
];
const MAX_TEXT_CONTINUATION_ROUNDS = 1;
const MAX_CONTROL_TAG_REPAIR_ROUNDS = 1;
const MAX_REASONING_ONLY_RECOVERY_ROUNDS = 1;
const MAX_REASONING_RECOVERY_CONTEXT_CHARS = 12_000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 20_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5_000;
const TEXT_CONTINUATION_CUE = `
Continue the previous assistant response exactly where it stopped.
Do not repeat earlier content.
Return only the continuation text.
`.trim();
const REASONING_ONLY_RECOVERY_CUE = `
The previous attempt exhausted its output budget before producing a user-facing answer.
Using the reasoning summary and partial answer above, return only the final answer for the user.
Do not include reasoning summaries, analysis, hidden notes, or XML/control tags.
`.trim();
function buildControlTagRepairCue(tags: string[]): string {
  const tagList = tags.map((tag) => `<${tag}>...</${tag}>`).join(", ");
  return `
Your previous response ended with incomplete control tag markup.
Return only the complete corrected control block(s) for: ${tagList}.
Do not include prose or repeat any normal user-facing text.
`.trim();
}

function truncateRecoveryContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[truncated]\n${text.slice(-maxChars)}`;
}

function escapeInternalBlockText(text: string, tag: string): string {
  return text.replaceAll(`</${tag}>`, `</ ${tag}>`);
}

function buildReasoningOnlyRecoveryContext(
  reasoning: string,
  partialAnswer: string,
): string {
  const safeReasoning = escapeInternalBlockText(
    truncateRecoveryContext(reasoning, MAX_REASONING_RECOVERY_CONTEXT_CHARS),
    "reasoning_summary",
  );
  const safePartialAnswer = escapeInternalBlockText(
    truncateRecoveryContext(
      partialAnswer,
      MAX_REASONING_RECOVERY_CONTEXT_CHARS,
    ),
    "partial_answer",
  );

  return `
<reasoning_summary>
${safeReasoning || "(none)"}
</reasoning_summary>

<partial_answer>
${safePartialAnswer || "(none)"}
</partial_answer>
`.trim();
}

function isReasoningOnlyLengthTruncation(
  answer: string,
  reasoning: string,
  finishReason: ProviderFinishReason | null,
  toolCalls: ToolInvocation[],
): boolean {
  return finishReason === "length" &&
    answer.trim().length === 0 &&
    reasoning.trim().length > 0 &&
    toolCalls.length === 0;
}

export type LLMProviderAttempt = {
  provider: ProviderName;
  model?: string;
  reason?: ProviderFallbackReason | null;
  status?: number;
  message?: string;
};

export class LLMProviderError extends Error {
  reason: ProviderFallbackReason | null;
  provider: ProviderName;
  model?: string;
  status?: number;
  attempts: LLMProviderAttempt[];
  fallbackAttempted: boolean;
  visibleStreamStarted: boolean;

  constructor(
    message: string,
    options: {
      reason: ProviderFallbackReason | null;
      provider: ProviderName;
      model?: string;
      status?: number;
      attempts?: LLMProviderAttempt[];
      fallbackAttempted?: boolean;
      visibleStreamStarted?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "LLMProviderError";
    this.reason = options.reason;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.attempts = options.attempts ?? [];
    this.fallbackAttempted = options.fallbackAttempted ?? false;
    this.visibleStreamStarted = options.visibleStreamStarted ?? false;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

class LLMStreamTimeoutError extends Error {
  constructor(kind: "first_token" | "idle", timeoutMs: number) {
    const label = kind === "first_token"
      ? "first token timeout"
      : "stream idle timeout";
    super(`LLM ${label} after ${timeoutMs}ms`);
    this.name = "AbortError";
  }
}

let defaultProviderRegistryPromise: Promise<ProviderRegistry> | undefined;

async function getProviderRegistry(
  registry?: ProviderRegistry,
): Promise<ProviderRegistry> {
  if (registry) return registry;
  if (!defaultProviderRegistryPromise) {
    defaultProviderRegistryPromise = import("@/runtime/llm/registry.ts")
      .then((mod) => mod.providers);
  }
  return await defaultProviderRegistryPromise;
}

function buildAttemptConfig(
  baseConfig: ProviderConfig,
  env: Record<string, string>,
  override?: ProviderFallbackConfig,
): ProviderConfig {
  const fallbackChangesProvider = override?.provider &&
    override.provider !== baseConfig.provider;
  const candidate = {
    ...baseConfig,
    ...(override ?? {}),
    ...(fallbackChangesProvider && !override?.apiKey
      ? { apiKey: undefined }
      : {}),
    fallbacks: undefined,
    fallbackOn: undefined,
  } as ProviderConfig;

  candidate.apiKey = resolveProviderApiKey(candidate, env);
  return withDefaultStopSequences(candidate);
}

export function classifyLLMError(
  error: unknown,
): ProviderFallbackReason | null {
  const requestError = error as {
    status?: number;
    statusText?: string;
    name?: string;
    message?: string;
  };

  if (requestError?.status === 401 || requestError?.status === 403) {
    return "auth_error";
  }

  if (
    requestError?.name === "AbortError" ||
    requestError?.status === 408 ||
    requestError?.status === 504
  ) {
    return "timeout";
  }

  if (requestError?.status === 429) {
    return "rate_limit";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 500
  ) {
    return "server_error";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 400
  ) {
    return "provider_error";
  }

  if (error instanceof Error) {
    return "network";
  }

  return "unknown";
}

function shouldAttemptFallback(
  error: unknown,
  fallbackOn?: ProviderFallbackReason[],
): boolean {
  const reason = classifyLLMError(error);
  if (!reason) return false;

  const allowedReasons = Array.isArray(fallbackOn) && fallbackOn.length > 0
    ? fallbackOn
    : DEFAULT_FALLBACK_REASONS;

  return allowedReasons.includes(reason);
}

function getErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTimeoutMs(
  value: number | undefined,
  defaultValue: number,
): number | undefined {
  if (value === undefined) return defaultValue;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function warnFallbackAttempt(
  error: unknown,
  attempt: ProviderConfig,
  reason: ProviderFallbackReason | null,
  nextAttempt: ProviderConfig,
): void {
  try {
    console.warn("[llm] Attempting fallback after provider error", {
      provider: attempt.provider,
      model: attempt.model,
      reason,
      message: getErrorMessage(error),
      fallbackProvider: nextAttempt.provider,
      fallbackModel: nextAttempt.model,
    });
  } catch {
    // Ignore logging failures.
  }
}

function normalizeProviderUsage(
  usage: ProviderUsageUpdate | undefined,
  status: TokenUsage["status"],
): TokenUsage | null {
  if (!usage) return null;

  const inputTokens = typeof usage.inputTokens === "number"
    ? usage.inputTokens
    : undefined;
  const outputTokens = typeof usage.outputTokens === "number"
    ? usage.outputTokens
    : undefined;
  const reasoningTokens = typeof usage.reasoningTokens === "number"
    ? usage.reasoningTokens
    : undefined;
  const cacheReadInputTokens = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : undefined;
  const cacheCreationInputTokens =
    typeof usage.cacheCreationInputTokens === "number"
      ? usage.cacheCreationInputTokens
      : undefined;
  const totalTokens = typeof usage.totalTokens === "number"
    ? usage.totalTokens
    : (inputTokens !== undefined && outputTokens !== undefined)
    ? inputTokens + outputTokens
    : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined &&
    !usage.rawUsage
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    source: "provider",
    status,
    rawUsage: usage.rawUsage ?? null,
  };
}

function sumUsageNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function mergeProviderUsage(
  left: ProviderUsageUpdate | undefined,
  right: ProviderUsageUpdate | undefined,
): ProviderUsageUpdate | undefined {
  if (!left) return right;
  if (!right) return left;

  return {
    inputTokens: sumUsageNumber(left.inputTokens, right.inputTokens),
    outputTokens: sumUsageNumber(left.outputTokens, right.outputTokens),
    reasoningTokens: sumUsageNumber(
      left.reasoningTokens,
      right.reasoningTokens,
    ),
    cacheReadInputTokens: sumUsageNumber(
      left.cacheReadInputTokens,
      right.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: sumUsageNumber(
      left.cacheCreationInputTokens,
      right.cacheCreationInputTokens,
    ),
    totalTokens: sumUsageNumber(left.totalTokens, right.totalTokens),
    rawUsage: {
      segments: [left.rawUsage ?? null, right.rawUsage ?? null],
    },
  };
}

function mergeExtractedTags(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
): Record<string, string[]> {
  const merged = { ...left };
  for (const [key, values] of Object.entries(right)) {
    merged[key] = [...(merged[key] ?? []), ...values];
  }
  return merged;
}

function parseAssistantResponse(
  response: string,
  extractedBlockTags: string[] = [],
  options: { preserveWhitespace?: boolean } = {},
): {
  cleanResponse: string;
  toolCalls: ToolInvocation[];
  extractedTags: Record<string, string[]>;
} {
  let cleanResponse = response;
  let toolCalls: ToolInvocation[] = [];
  let extractedTags: Record<string, string[]> = {};

  {
    const parsed = parseToolCallsFromResponse(response);
    cleanResponse = parsed.cleanResponse;
    toolCalls = parsed.toolCalls;
  }
  if (extractedBlockTags.length > 0) {
    const parsed = parseTaggedBlocksFromResponse(
      cleanResponse,
      extractedBlockTags,
    );
    cleanResponse = parsed.cleanResponse;
    extractedTags = parsed.extractedTags;
  } else if (!options.preserveWhitespace) {
    cleanResponse = cleanResponse.trim();
  }
  if (
    cleanResponse.includes("<no_response") ||
    cleanResponse.includes("<tool_results>") ||
    cleanResponse.includes("<continue_after_tool_results")
  ) {
    const parsed = parseInternalControlTagsFromResponse(cleanResponse);
    cleanResponse = parsed.cleanResponse;
  } else if (!options.preserveWhitespace) {
    cleanResponse = cleanResponse.trim();
  }

  return { cleanResponse, toolCalls, extractedTags };
}

/**
 * Unified AI Chat endpoint with comprehensive multimodal support
 * Handles text, images, audio, video, and documents across all providers
 *
 * @param request - The chat request
 * @param config - The provider configuration
 * @param env - The environment variables
 * @param stream - The stream callback
 * @returns The chat response
 */

export async function chat(
  request: ChatRequest,
  config: ProviderConfig,
  env: Record<string, string> = {},
  stream?: StreamCallback,
  providerRegistry?: ProviderRegistry,
): Promise<ChatResponse> {
  // Handle mock responses
  if (request.answer) {
    return createMockResponse(request);
  }
  const baseConfig = {
    ...config,
    ...request.config,
  } as ProviderConfig;

  const providerFromRequest =
    (request as ChatRequest & { provider?: ProviderName })
      .provider;
  if (!baseConfig.provider && providerFromRequest) {
    baseConfig.provider = providerFromRequest;
  }
  if (!baseConfig.provider) {
    throw new Error("No LLM provider configured for chat request");
  }

  // Format messages — merge provider `config` into the request so
  // `limitEstimatedInputTokens` (and any future ChatRequest-scoped options)
  // apply. `llm_call` passes LLM options only via the second argument, so
  // `request.config` is often undefined.
  const messages = formatMessages({
    ...request,
    messages: request.messages,
    config: toLLMConfig(baseConfig),
  });

  const attemptConfigs = [
    buildAttemptConfig(baseConfig, env),
    ...(baseConfig.fallbacks ?? []).map((fallback) =>
      buildAttemptConfig(baseConfig, env, fallback)
    ),
  ];

  let lastError: unknown = null;
  const attempts: LLMProviderAttempt[] = [];
  const registry = await getProviderRegistry(providerRegistry);
  let visibleTimeoutContinuation: { prefix: string } | undefined;

  for (let index = 0; index < attemptConfigs.length; index++) {
    const attemptConfig = attemptConfigs[index];
    const attemptProvider = attemptConfig.provider!;
    const providerFactory = registry[attemptProvider];
    if (!providerFactory) {
      throw new Error(
        `Provider '${attemptProvider}' is not supported. Available providers: ${
          Object.keys(registry).join(", ")
        }`,
      );
    }
    const providerAPI = providerFactory(attemptConfig);
    let visibleStreamStarted = false;
    let visibleAnswerBuffer = "";
    const continuationPrefix = visibleTimeoutContinuation?.prefix ?? "";
    const trackedStream = stream
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 || options?.isReasoning) {
          visibleStreamStarted = true;
        }
        if (chunk.length > 0 && !options?.isReasoning) {
          visibleAnswerBuffer += chunk;
        }
        stream(chunk, options);
      })
      : undefined;

    try {
      const runProviderStream = async (
        runMessages: ChatMessage[],
        onStream: StreamCallback | undefined,
        configOverrides?: Partial<ProviderConfig>,
      ) => {
        const effectiveAttemptConfig = {
          ...attemptConfig,
          ...(configOverrides ?? {}),
        } as ProviderConfig;
        const effectiveRequestConfig = {
          ...effectiveAttemptConfig,
          stop: undefined,
          stopSequences: undefined,
        } satisfies ProviderConfig;
        const effectiveLocalStopSequences = getLocalStopSequences(
          effectiveAttemptConfig,
        );
        const finalMessages = providerAPI.transformMessages
          ? providerAPI.transformMessages(runMessages)
          : runMessages;
        const abortController = new AbortController();
        const firstTokenTimeoutMs = resolveTimeoutMs(
          effectiveAttemptConfig.firstTokenTimeoutMs,
          DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
        );
        const streamIdleTimeoutMs = resolveTimeoutMs(
          effectiveAttemptConfig.streamIdleTimeoutMs,
          DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        );
        let firstTokenTimer: number | undefined;
        let streamIdleTimer: number | undefined;
        let rejectTimeout: ((error: Error) => void) | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let streamTimeout:
          | { kind: "first_token" | "idle"; timeoutMs: number }
          | undefined;
        let firstStreamActivityReceived = false;
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
        const startFirstTokenTimer = () => {
          if (!firstTokenTimeoutMs) return;
          clearFirstTokenTimer();
          firstTokenTimer = setTimeout(() => {
            abortForTimeout("first_token", firstTokenTimeoutMs);
          }, firstTokenTimeoutMs) as unknown as number;
        };
        const resetStreamIdleTimer = () => {
          if (!streamIdleTimeoutMs || !firstStreamActivityReceived) return;
          clearStreamIdleTimer();
          streamIdleTimer = setTimeout(() => {
            abortForTimeout("idle", streamIdleTimeoutMs);
          }, streamIdleTimeoutMs) as unknown as number;
        };
        const recordStreamActivity = () => {
          if (!firstStreamActivityReceived) {
            firstStreamActivityReceived = true;
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
                Array.isArray(finalMessages) ? finalMessages : runMessages,
                effectiveRequestConfig,
              ),
              {
                headers: providerAPI.headers(effectiveRequestConfig),
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
              if (
                parts?.some((part) =>
                  typeof part.text === "string" && part.text.length > 0
                )
              ) {
                recordStreamActivity();
              }
              return parts;
            },
            {
              ...providerAPI.streamOptions,
              config: effectiveAttemptConfig,
              extractedBlockTags: request.extractTags,
              extractUsage: providerAPI.extractUsage,
              extractFinishReason: providerAPI.extractFinishReason,
              localStopSequences: effectiveLocalStopSequences,
              onLocalStop: () => abortController.abort(),
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
        }
      };

      const initialMessages = continuationPrefix.length > 0
        ? [
          ...messages,
          { role: "assistant", content: continuationPrefix } as ChatMessage,
          { role: "user", content: TEXT_CONTINUATION_CUE } as ChatMessage,
        ]
        : messages;
      let streamResult = await runProviderStream(
        initialMessages,
        trackedStream,
      );

      let cleanResponse = streamResult.content;
      let toolCalls: ToolInvocation[] = [];
      let extractedTags: Record<string, string[]> = {};
      let parsedResponse = parseAssistantResponse(
        streamResult.content,
        request.extractTags ?? [],
        continuationPrefix.length > 0 ? { preserveWhitespace: true } : {},
      );
      cleanResponse = `${continuationPrefix}${parsedResponse.cleanResponse}`;
      toolCalls = parsedResponse.toolCalls;
      extractedTags = parsedResponse.extractedTags;
      let aggregateUsage = streamResult.usage;
      let aggregateReasoning = streamResult.reasoning;
      let finalFinishReason: ProviderFinishReason | null =
        streamResult.finishReason;
      const controlTagNames = [
        ...COPILOTZ_CONTROL_TAGS,
        ...(request.extractTags ?? []),
      ];
      const danglingTags = findDanglingControlTags(
        streamResult.content,
        controlTagNames,
      );

      if (danglingTags.length > 0) {
        for (let i = 0; i < MAX_CONTROL_TAG_REPAIR_ROUNDS; i++) {
          const repairResult = await runProviderStream([
            ...messages,
            { role: "assistant", content: streamResult.content },
            { role: "user", content: buildControlTagRepairCue(danglingTags) },
          ], undefined);
          aggregateUsage = mergeProviderUsage(
            aggregateUsage,
            repairResult.usage,
          );
          aggregateReasoning = `${aggregateReasoning}${repairResult.reasoning}`;
          finalFinishReason = repairResult.finishReason ?? finalFinishReason;

          const repairedContent = `${
            stripDanglingControlTail(streamResult.content, controlTagNames)
          }${repairResult.content}`;
          const repaired = parseAssistantResponse(
            repairedContent,
            request.extractTags ?? [],
            continuationPrefix.length > 0 ? { preserveWhitespace: true } : {},
          );
          streamResult = { ...streamResult, content: repairedContent };
          cleanResponse = `${continuationPrefix}${repaired.cleanResponse}`;
          toolCalls = repaired.toolCalls;
          extractedTags = repaired.extractedTags;
          break;
        }
      } else if (
        isReasoningOnlyLengthTruncation(
          cleanResponse,
          aggregateReasoning,
          finalFinishReason,
          toolCalls,
        )
      ) {
        for (let i = 0; i < MAX_REASONING_ONLY_RECOVERY_ROUNDS; i++) {
          const recoveryResult = await runProviderStream(
            [
              ...messages,
              {
                role: "assistant",
                content: buildReasoningOnlyRecoveryContext(
                  aggregateReasoning,
                  cleanResponse,
                ),
              } as ChatMessage,
              {
                role: "user",
                content: REASONING_ONLY_RECOVERY_CUE,
              } as ChatMessage,
            ],
            trackedStream,
            {
              openaiReasoningSummary: false,
              reasoningEffort: "minimal",
              outputReasoning: false,
            },
          );
          aggregateUsage = mergeProviderUsage(
            aggregateUsage,
            recoveryResult.usage,
          );
          aggregateReasoning =
            `${aggregateReasoning}${recoveryResult.reasoning}`;
          finalFinishReason = recoveryResult.finishReason ?? finalFinishReason;

          const recovered = parseAssistantResponse(
            recoveryResult.content,
            request.extractTags ?? [],
            { preserveWhitespace: true },
          );
          cleanResponse = `${cleanResponse}${recovered.cleanResponse}`;
          toolCalls = recovered.toolCalls;
          extractedTags = mergeExtractedTags(
            extractedTags,
            recovered.extractedTags,
          );
          break;
        }
      } else if (streamResult.finishReason === "length") {
        for (let i = 0; i < MAX_TEXT_CONTINUATION_ROUNDS; i++) {
          const continuationResult = await runProviderStream([
            ...messages,
            { role: "assistant", content: cleanResponse },
            { role: "user", content: TEXT_CONTINUATION_CUE },
          ], trackedStream);
          aggregateUsage = mergeProviderUsage(
            aggregateUsage,
            continuationResult.usage,
          );
          aggregateReasoning =
            `${aggregateReasoning}${continuationResult.reasoning}`;
          finalFinishReason = continuationResult.finishReason ??
            finalFinishReason;

          const continued = parseAssistantResponse(
            continuationResult.content,
            request.extractTags ?? [],
            { preserveWhitespace: true },
          );
          cleanResponse = `${cleanResponse}${continued.cleanResponse}`;
          extractedTags = mergeExtractedTags(
            extractedTags,
            continued.extractedTags,
          );
          if (continuationResult.finishReason !== "length") break;
        }
      }

      if (
        isReasoningOnlyLengthTruncation(
          cleanResponse,
          aggregateReasoning,
          finalFinishReason,
          toolCalls,
        )
      ) {
        throw Object.assign(
          new Error(
            "LLM produced reasoning but no user-facing answer before hitting the output limit.",
          ),
          { status: 400 },
        );
      }

      const usageStatus: TokenUsage["status"] = streamResult.stoppedByLocalStop
        ? "aborted"
        : "completed";
      const usage = normalizeProviderUsage(aggregateUsage, usageStatus) ??
        await estimateUsage(messages, cleanResponse, usageStatus);
      const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
      const totalTokens = usage.totalTokens ??
        await countTokens(messages, cleanResponse);

      const chatResponse: ChatResponse = {
        prompt: messages,
        answer: cleanResponse,
        ...(aggregateReasoning && { reasoning: aggregateReasoning }),
        tokens: totalTokens,
        finishReason: finalFinishReason,
        usage,
        ...(cost ? { cost } : {}),
        provider: attemptProvider,
        model: attemptConfig.model,
        ...(toolCalls.length > 0 && { toolCalls }),
        ...(Object.keys(extractedTags).length > 0 && { extractedTags }),
      };

      const responseWithMetadata = {
        ...chatResponse,
        metadata: {
          provider: attemptProvider,
          timestamp: new Date().toISOString(),
          messageCount: request.messages.length,
        },
      };

      return responseWithMetadata;
    } catch (error) {
      lastError = error;
      const reason = classifyLLMError(error);
      const hasFallback = index < attemptConfigs.length - 1;
      const fallbackAllowed = shouldAttemptFallback(
        error,
        baseConfig.fallbackOn,
      );
      const continuationCandidatePrefix =
        `${continuationPrefix}${visibleAnswerBuffer}`;
      attempts.push({
        provider: attemptProvider,
        model: attemptConfig.model,
        reason,
        status: getErrorStatus(error),
        message: getErrorMessage(error),
      });

      if (
        hasFallback &&
        fallbackAllowed &&
        reason === "timeout" &&
        continuationCandidatePrefix.length > 0
      ) {
        visibleTimeoutContinuation = {
          prefix: continuationCandidatePrefix,
        };
        warnFallbackAttempt(
          error,
          attemptConfig,
          reason,
          attemptConfigs[index + 1],
        );
        continue;
      }

      if (
        !hasFallback ||
        visibleStreamStarted ||
        !fallbackAllowed
      ) {
        throw new LLMProviderError(getErrorMessage(error), {
          reason,
          provider: attemptProvider,
          model: attemptConfig.model,
          status: getErrorStatus(error),
          attempts,
          fallbackAttempted: attempts.length > 1,
          visibleStreamStarted,
          cause: error,
        });
      }
      warnFallbackAttempt(
        error,
        attemptConfig,
        reason,
        attemptConfigs[index + 1],
      );
    }
  }

  if (lastError) {
    const lastAttempt = attempts[attempts.length - 1];
    throw new LLMProviderError(getErrorMessage(lastError), {
      reason: lastAttempt?.reason ?? classifyLLMError(lastError),
      provider: lastAttempt?.provider ?? baseConfig.provider,
      model: lastAttempt?.model ?? baseConfig.model,
      status: lastAttempt?.status ?? getErrorStatus(lastError),
      attempts,
      fallbackAttempted: attempts.length > 1,
      cause: lastError,
    });
  }
  throw new Error(
    "LLM chat exhausted all attempts without returning a response",
  );
}

export * from "@/runtime/llm/types.ts";
