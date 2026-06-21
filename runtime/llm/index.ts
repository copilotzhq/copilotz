import type {
  ChatRequest,
  ChatResponse,
  LLMUsageAttempt,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderFinishReason,
  ProviderName,
  ProviderRegistry,
  StreamCallback,
  TokenUsage,
  TokenUsageStatusReason,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { estimateUsageCost } from "@/runtime/llm/pricing.ts";
import { resolveProviderApiKey, toLLMConfig } from "@/runtime/llm/config.ts";
import {
  countTokens,
  createMockResponse,
  detectDegenerateRepetition,
  estimateUsage,
  formatMessages,
  parseInternalControlTagsFromResponse,
  parseTaggedBlocksFromResponse,
  parseToolCallsFromResponse,
  responseHasMalformedToolCallIntent,
  responseHasReasoningMarkup,
  responseHasToolIntent,
  sanitizeUserFacingText,
  stripStructuralLeakTokens,
  withDefaultStopSequences,
} from "@/runtime/llm/utils.ts";
import { normalizeProviderUsage } from "@/runtime/llm/usage.ts";
import { runProviderStream } from "@/runtime/llm/stream.ts";
import {
  classifyLLMError,
  getErrorMessage,
  getErrorStatus,
  type LLMProviderAttempt,
  LLMProviderError,
} from "@/runtime/llm/errors.ts";

export { classifyLLMError, LLMProviderError } from "@/runtime/llm/errors.ts";
export type { LLMProviderAttempt } from "@/runtime/llm/errors.ts";

const RECOVERABLE_FINISH_REASONS: ReadonlySet<ProviderFinishReason> = new Set([
  "length",
  "error",
  "content_filter",
]);

const INTENTIONAL_EMPTY_PATTERN =
  /<(no_response|route_to|ask_to|continue_after_tool_results)[\s/>]/;
const REASONING_HISTORY_TAGS = [
  "think",
  "thought",
  "thinking",
  "reasoning",
] as const;
const DEFAULT_REASONING_HISTORY_MAX_CHARS = 2000;
const RECOVERY_PROTOCOL_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool|tool_result|tool_results|result|continue_after_tool_results|target_ids)\b/i;
const VISIBLE_REASONING_BLOCK_PATTERN =
  /<(?:mm:)?(?:think|thought|thinking|reasoning)\b[^>]*>([\s\S]*?)(?:<\/(?:mm:)?(?:think|thought|thinking|reasoning)>|$)/gi;

function buildRecoveryCue(reason: string | null): string {
  switch (reason) {
    case "length":
      return "<recovery_cue>Previous response exceeded maximum output length. Continue where you left off. Be concise and break into smaller steps if needed.</recovery_cue>";
    case "timeout":
      return "<recovery_cue>Previous response was interrupted by a timeout. Continue where you left off. Be concise.</recovery_cue>";
    case "content_filter":
      return "<recovery_cue>Previous response was blocked by a content filter. Continue where you left off, rephrasing as needed.</recovery_cue>";
    case "error":
      return "<recovery_cue>Previous response was interrupted by a provider error. Continue where you left off.</recovery_cue>";
    case "empty_response":
      return "<recovery_cue>Previous attempt produced reasoning but no visible response. You must produce a concrete answer for the user.</recovery_cue>";
    case "degenerate_repetition":
      return "<recovery_cue>Your previous response degenerated into repeated text. The previous assistant message is already present and correct before the repeated section. Continue from that point with a concise final answer. Do not repeat earlier content, tool results, JSON fragments, or repeated tokens.</recovery_cue>";
    case "malformed_tool_call":
      return `<recovery_cue>
The previous assistant message is already present in the conversation and is correct up to the attempted tool call. Do not repeat it.
If you intended to call a tool, emit only the corrected <tool_calls> block.
If you did not intend to call a tool, continue from the previous assistant message without any tool or result protocol.
</recovery_cue>`;
    default:
      return "<recovery_cue>Continue exactly where you left off. Do not repeat earlier content.</recovery_cue>";
  }
}

function normalizeReasoningHistoryOptions(
  options: ChatRequest["reasoningHistory"] | undefined,
): Required<NonNullable<ChatRequest["reasoningHistory"]>> {
  return {
    include: options?.include ?? "self",
    maxChars: typeof options?.maxChars === "number"
      ? options.maxChars
      : DEFAULT_REASONING_HISTORY_MAX_CHARS,
  };
}

function truncateReasoningForRecovery(
  reasoning: string,
  maxChars: number,
): string {
  if (maxChars === 0 || reasoning.length <= maxChars) return reasoning;
  if (maxChars < 48) return "[reasoning truncated]";
  const suffix = `\n[reasoning truncated: ${
    reasoning.length - maxChars
  } chars omitted]`;
  return `${
    reasoning.slice(0, Math.max(0, maxChars - suffix.length))
  }${suffix}`;
}

function extractVisibleReasoningMarkup(response: string): string[] {
  const parts: string[] = [];
  for (const match of response.matchAll(VISIBLE_REASONING_BLOCK_PATTERN)) {
    const value = match[1]?.trim();
    if (value) parts.push(stripStructuralLeakTokens(value));
  }
  return parts.filter((part) => part.trim().length > 0);
}

function getSafeVisiblePrefixBeforeProtocol(response: string): string {
  const markerIndex = response.search(RECOVERY_PROTOCOL_MARKER_PATTERN);
  const prefix = markerIndex === -1 ? response : response.slice(0, markerIndex);
  return sanitizeUserFacingText(prefix);
}

function buildRecoveryAssistantContext(
  existingContext: string,
  visiblePrefix: string,
  reasoning: string | undefined,
  options: ChatRequest["reasoningHistory"] | undefined,
): string {
  const reasoningHistory = normalizeReasoningHistoryOptions(options);
  const parts: string[] = [];
  const trimmedReasoning = reasoning?.trim();
  if (
    reasoningHistory.include !== "none" &&
    typeof trimmedReasoning === "string" &&
    trimmedReasoning.length > 0
  ) {
    parts.push(
      `<think>\n${
        truncateReasoningForRecovery(
          trimmedReasoning,
          reasoningHistory.maxChars,
        )
      }\n</think>`,
    );
  }

  const trimmedVisiblePrefix = visiblePrefix.trim();
  if (trimmedVisiblePrefix.length > 0) {
    parts.push(trimmedVisiblePrefix);
  }

  const attemptContext = parts.join("\n\n");
  return [existingContext.trim(), attemptContext].filter((part) =>
    part.length > 0
  ).join("\n\n");
}

function joinRecoveredContent(prefix: string, continuation: string): string {
  if (!prefix) return continuation;
  if (!continuation) return prefix;
  if (/\s$/.test(prefix) || /^\s/.test(continuation)) {
    return prefix + continuation;
  }
  if (/^[.,;:!?)]/.test(continuation)) {
    return prefix + continuation;
  }
  return `${prefix} ${continuation}`;
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
  } as ProviderConfig;

  candidate.apiKey = resolveProviderApiKey(candidate, env);
  return withDefaultStopSequences(candidate);
}

function parseAssistantResponse(
  response: string,
  extractedBlockTags: string[] = [],
  knownToolNames: string[] = [],
): {
  cleanResponse: string;
  toolCalls: ToolInvocation[];
  extractedTags: Record<string, string[]>;
} {
  let cleanResponse = response;
  let toolCalls: ToolInvocation[] = [];
  let extractedTags: Record<string, string[]> = {};

  {
    const parsed = parseToolCallsFromResponse(response, knownToolNames);
    cleanResponse = parsed.cleanResponse;
    toolCalls = parsed.toolCalls;
  }
  const visibleExtractedBlockTags = extractedBlockTags.filter((tag) =>
    !REASONING_HISTORY_TAGS.includes(
      tag.toLowerCase() as typeof REASONING_HISTORY_TAGS[number],
    )
  );
  if (extractedBlockTags.length > 0) {
    const parsed = parseTaggedBlocksFromResponse(
      cleanResponse,
      visibleExtractedBlockTags,
    );
    cleanResponse = parsed.cleanResponse;
    extractedTags = parsed.extractedTags;
  } else {
    cleanResponse = cleanResponse.trim();
  }
  if (
    cleanResponse.includes("<no_response") ||
    cleanResponse.includes("<tool_results>") ||
    cleanResponse.includes("<continue_after_tool_results")
  ) {
    const parsed = parseInternalControlTagsFromResponse(cleanResponse);
    cleanResponse = parsed.cleanResponse;
  } else {
    cleanResponse = cleanResponse.trim();
  }

  // Structural special-token leaks are never legitimate output; strip always.
  cleanResponse = sanitizeUserFacingText(
    stripStructuralLeakTokens(cleanResponse),
  ).trim();

  return { cleanResponse, toolCalls, extractedTags };
}

function mergeReasoningParts(...parts: Array<string | string[] | undefined>) {
  const values = parts.flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part): part is string =>
      typeof part === "string" && part.trim().length > 0
    )
    .map((part) => part.trim());
  return values.length > 0 ? values.join("\n\n") : undefined;
}

function warnRecoveryAttempt(
  reason: string | null,
  current: ProviderConfig,
  next: ProviderConfig,
  message?: string,
): void {
  try {
    console.warn("[llm] Attempting recovery", {
      provider: current.provider,
      model: current.model,
      reason,
      ...(message ? { message } : {}),
      nextProvider: next.provider,
      nextModel: next.model,
    });
  } catch {
    // Ignore logging failures.
  }
}

function hasMeaningfulVisibleOutput(text: string): boolean {
  return text.trim().length > 0;
}

function toUsageStatusReason(
  reason: string | null,
): TokenUsageStatusReason | undefined {
  switch (reason) {
    case "local_stop_sequence":
    case "length":
    case "error":
    case "timeout":
    case "network":
    case "auth_error":
    case "rate_limit":
    case "server_error":
    case "provider_error":
    case "unknown":
    case "content_filter":
    case "empty_response":
    case "malformed_tool_call":
    case "visible_reasoning_markup":
    case "degenerate_repetition":
      return reason;
    default:
      return undefined;
  }
}

function usageStatusForReason(
  statusReason?: TokenUsageStatusReason,
): TokenUsage["status"] {
  switch (statusReason) {
    case "error":
    case "timeout":
    case "network":
    case "auth_error":
    case "rate_limit":
    case "server_error":
    case "provider_error":
    case "unknown":
    case "content_filter":
      return "aborted";
    default:
      return "completed";
  }
}

/**
 * Unified AI Chat endpoint.
 *
 * Streams an LLM response through the configured provider. Before user-visible
 * output is emitted it may recover with retry/fallback attempts; after visible
 * output starts it preserves that partial response and avoids hidden fallbacks.
 */
export async function chat(
  request: ChatRequest,
  config: ProviderConfig,
  env: Record<string, string> = {},
  stream?: StreamCallback,
  providerRegistry?: ProviderRegistry,
): Promise<ChatResponse> {
  if (request.answer) {
    return createMockResponse(request);
  }

  const baseConfig = {
    ...config,
    ...request.config,
  } as ProviderConfig;

  const providerFromRequest =
    (request as ChatRequest & { provider?: ProviderName }).provider;
  if (!baseConfig.provider && providerFromRequest) {
    baseConfig.provider = providerFromRequest;
  }
  if (!baseConfig.provider) {
    throw new Error("No LLM provider configured for chat request");
  }

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

  const registry = await getProviderRegistry(providerRegistry);
  const knownToolNames = (request.tools ?? [])
    .map((tool) => tool?.function?.name)
    .filter((name): name is string =>
      typeof name === "string" && name.length > 0
    );
  let lastError: unknown = null;
  const attempts: LLMProviderAttempt[] = [];
  const usageAttempts: LLMUsageAttempt[] = [];
  let recoveryPrefix = "";
  let lastRecoveryReason: string | null = null;
  let sameModelRetried = false;
  let visibleOutputStarted = false;
  let silentRepairNextAttempt = false;

  let index = 0;
  while (index < attemptConfigs.length) {
    if (request.signal?.aborted) {
      throw new DOMException("LLM request aborted", "AbortError");
    }
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
    const attemptId = crypto.randomUUID();
    let attemptVisibleOutputStarted = false;
    let attemptVisibleOutput = "";
    const silentRepairAttempt = silentRepairNextAttempt;
    silentRepairNextAttempt = false;

    const trackedStream = stream && !silentRepairAttempt
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 && !options?.isReasoning) {
          if (hasMeaningfulVisibleOutput(chunk)) {
            attemptVisibleOutputStarted = true;
            visibleOutputStarted = true;
          }
          attemptVisibleOutput += chunk;
          recoveryPrefix += chunk;
        }
        stream(chunk, options);
      })
      : undefined;

    const prefixBeforeAttempt = recoveryPrefix;
    const materializedMessages = request.materializeMessages
      ? await request.materializeMessages(messages, attemptConfig)
      : messages;
    const attemptMessages = prefixBeforeAttempt.length > 0
      ? [
        ...materializedMessages,
        { role: "assistant" as const, content: prefixBeforeAttempt },
        {
          role: "user" as const,
          content: buildRecoveryCue(lastRecoveryReason),
        },
      ]
      : materializedMessages;

    try {
      const extractedBlockTags = [
        ...(request.extractTags ?? []),
        ...REASONING_HISTORY_TAGS,
      ];
      const streamResult = await runProviderStream(
        attemptMessages,
        trackedStream,
        attemptConfig,
        providerAPI,
        extractedBlockTags,
        request.signal,
      );
      let finalStatusReason: TokenUsageStatusReason | undefined;

      const buildUsageAttempt = async (
        statusReason?: TokenUsageStatusReason,
      ): Promise<LLMUsageAttempt> => {
        const usageStatus = streamResult.stoppedByLocalStop
          ? "locally_stopped"
          : usageStatusForReason(statusReason);
        const usageMetadata = {
          ...(streamResult.stoppedByLocalStop || statusReason
            ? {
              statusReason: statusReason ??
                streamResult.localStopReason ?? "local_stop_sequence",
            }
            : {}),
          ...(streamResult.localStopSequence
            ? { stopSequence: streamResult.localStopSequence }
            : {}),
        } satisfies Pick<TokenUsage, "statusReason" | "stopSequence">;
        const usage = normalizeProviderUsage(
          streamResult.usage,
          usageStatus,
          usageMetadata,
        ) ??
          await estimateUsage(
            attemptMessages,
            streamResult.content,
            usageStatus,
            usageMetadata,
          );
        const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
        const usageFinalized = streamResult.usageFinalized
          ? streamResult.usageFinalized.then(async (finalized) => {
            const finalUsage = normalizeProviderUsage(
              finalized.usage,
              usageStatus,
              usageMetadata,
            );
            if (!finalUsage) return null;
            const finalCost = await estimateUsageCost(
              attemptConfig,
              finalUsage,
            );
            return {
              usage: finalUsage,
              ...(finalCost ? { cost: finalCost } : {}),
              tokens: finalUsage.totalTokens ??
                await countTokens(attemptMessages, streamResult.content),
              finishReason: finalized.finishReason,
              finalizedAt: new Date().toISOString(),
            };
          })
          : undefined;
        return {
          attemptId,
          provider: attemptProvider,
          model: attemptConfig.model,
          usage,
          ...(cost ? { cost } : {}),
          visibleOutputStarted: attemptVisibleOutputStarted,
          ...(usageFinalized ? { usageFinalized } : {}),
        };
      };

      // Check for recoverable finish reasons (length, error, content_filter)
      if (
        streamResult.finishReason &&
        RECOVERABLE_FINISH_REASONS.has(streamResult.finishReason)
      ) {
        const recoveryStatusReason = streamResult
          .finishReason as TokenUsageStatusReason;
        lastRecoveryReason = streamResult.finishReason;

        // For length: retry same model once — continuation context means
        // the model only needs to finish the remaining part.
        if (streamResult.finishReason === "length" && !sameModelRetried) {
          usageAttempts.push(await buildUsageAttempt("length"));
          sameModelRetried = true;
          warnRecoveryAttempt(
            "length",
            attemptConfig,
            attemptConfig,
            "Retrying same model with continuation context",
          );
          continue;
        }

        // Provider/model fallback is only safe before any visible output has
        // reached the user. After that, fall through and finalize the partial
        // visible response instead of silently switching models.
        if (index < attemptConfigs.length - 1 && !visibleOutputStarted) {
          usageAttempts.push(
            await buildUsageAttempt(recoveryStatusReason),
          );
          sameModelRetried = false;
          warnRecoveryAttempt(
            streamResult.finishReason,
            attemptConfig,
            attemptConfigs[index + 1],
          );
          index++;
          continue;
        }

        finalStatusReason = recoveryStatusReason;
        // No more safe attempts — fall through to return what we have.
      }

      // Success or exhausted recovery options — build response
      const fullContent = joinRecoveredContent(
        prefixBeforeAttempt,
        streamResult.content,
      );
      const parsed = parseAssistantResponse(
        fullContent,
        extractedBlockTags,
        knownToolNames,
      );
      const reasoning = mergeReasoningParts(streamResult.reasoning);
      const parsedCurrentAttempt = parseAssistantResponse(
        streamResult.content,
        extractedBlockTags,
        knownToolNames,
      );

      // Detect a malformed tool-call attempt: the model emitted tool-call
      // markup (canonical or a native dialect) that produced no parseable call.
      // Correct it with a synthetic instruction and retry. If the user has
      // already seen text, keep the repair silent and avoid provider fallback.
      const hasMalformedToolIntent = responseHasMalformedToolCallIntent(
        streamResult.content,
        knownToolNames,
      ) ||
        (parsedCurrentAttempt.toolCalls.length === 0 &&
          responseHasToolIntent(streamResult.content, knownToolNames));
      const hasVisibleReasoningMarkup = responseHasReasoningMarkup(
        streamResult.content,
      );
      const degenerateRepetition = detectDegenerateRepetition(
        streamResult.content,
      );

      // Detect unintentional empty response: model produced no useful
      // output and didn't use any control action (tool calls, routing, etc.)
      const isUnintentionallyEmpty = parsed.cleanResponse.length === 0 &&
        parsed.toolCalls.length === 0 &&
        Object.keys(parsed.extractedTags).length === 0 &&
        !INTENTIONAL_EMPTY_PATTERN.test(fullContent);

      if (hasMalformedToolIntent) {
        const safeVisiblePrefix = getSafeVisiblePrefixBeforeProtocol(
          streamResult.content,
        );
        const recoveryReasoning = mergeReasoningParts(
          streamResult.reasoning,
          extractVisibleReasoningMarkup(streamResult.content),
        );
        recoveryPrefix = buildRecoveryAssistantContext(
          prefixBeforeAttempt,
          safeVisiblePrefix,
          recoveryReasoning,
          request.reasoningHistory,
        );
        lastRecoveryReason = "malformed_tool_call";

        if (!sameModelRetried) {
          usageAttempts.push(await buildUsageAttempt("malformed_tool_call"));
          sameModelRetried = true;
          if (visibleOutputStarted) {
            silentRepairNextAttempt = true;
          }
          warnRecoveryAttempt(
            "malformed_tool_call",
            attemptConfig,
            attemptConfig,
            "Model emitted an unparseable tool call, retrying",
          );
          continue;
        }

        if (index < attemptConfigs.length - 1 && !visibleOutputStarted) {
          usageAttempts.push(await buildUsageAttempt("malformed_tool_call"));
          sameModelRetried = false;
          warnRecoveryAttempt(
            "malformed_tool_call",
            attemptConfig,
            attemptConfigs[index + 1],
            "Model emitted an unparseable tool call, falling back",
          );
          index++;
          continue;
        }

        // No more attempts — sanitize protocol markup out of the answer so the
        // user never sees a leaked tool call, then fall through to return.
        parsed.cleanResponse = sanitizeUserFacingText(parsed.cleanResponse);
      } else if (degenerateRepetition) {
        const safeVisiblePrefix = sanitizeUserFacingText(
          streamResult.content.slice(0, degenerateRepetition.startIndex),
        );
        recoveryPrefix = buildRecoveryAssistantContext(
          prefixBeforeAttempt,
          safeVisiblePrefix,
          streamResult.reasoning,
          request.reasoningHistory,
        );
        lastRecoveryReason = "degenerate_repetition";

        if (visibleOutputStarted) {
          finalStatusReason = "degenerate_repetition";
          parsed.cleanResponse = sanitizeUserFacingText(
            [prefixBeforeAttempt, safeVisiblePrefix].filter((part) =>
              part.trim().length > 0
            ).join(" "),
          );
        } else if (!sameModelRetried) {
          usageAttempts.push(await buildUsageAttempt("degenerate_repetition"));
          sameModelRetried = true;
          warnRecoveryAttempt(
            "degenerate_repetition",
            attemptConfig,
            attemptConfig,
            "Model output degenerated into repeated text, retrying",
          );
          continue;
        } else if (index < attemptConfigs.length - 1) {
          usageAttempts.push(await buildUsageAttempt("degenerate_repetition"));
          sameModelRetried = false;
          warnRecoveryAttempt(
            "degenerate_repetition",
            attemptConfig,
            attemptConfigs[index + 1],
            "Model output degenerated into repeated text, falling back",
          );
          index++;
          continue;
        } else {
          finalStatusReason = "degenerate_repetition";
          parsed.cleanResponse = sanitizeUserFacingText(
            [prefixBeforeAttempt, safeVisiblePrefix].filter((part) =>
              part.trim().length > 0
            ).join(" "),
          );
        }
      } else if (hasVisibleReasoningMarkup) {
        recoveryPrefix = prefixBeforeAttempt;
        lastRecoveryReason = "visible_reasoning_markup";

        if (visibleOutputStarted) {
          finalStatusReason = "visible_reasoning_markup";
          parsed.cleanResponse = sanitizeUserFacingText(parsed.cleanResponse);
        } else if (!sameModelRetried) {
          usageAttempts.push(
            await buildUsageAttempt("visible_reasoning_markup"),
          );
          sameModelRetried = true;
          warnRecoveryAttempt(
            "visible_reasoning_markup",
            attemptConfig,
            attemptConfig,
            "Model exposed reasoning markup, retrying",
          );
          continue;
        } else if (index < attemptConfigs.length - 1) {
          usageAttempts.push(
            await buildUsageAttempt("visible_reasoning_markup"),
          );
          sameModelRetried = false;
          warnRecoveryAttempt(
            "visible_reasoning_markup",
            attemptConfig,
            attemptConfigs[index + 1],
            "Model exposed reasoning markup, falling back",
          );
          index++;
          continue;
        } else {
          finalStatusReason = "visible_reasoning_markup";
          parsed.cleanResponse = sanitizeUserFacingText(parsed.cleanResponse);
        }
      } else if (isUnintentionallyEmpty) {
        // Undo the accumulation from this attempt — no useful content
        recoveryPrefix = prefixBeforeAttempt;
        lastRecoveryReason = "empty_response";

        if (!sameModelRetried && !visibleOutputStarted) {
          usageAttempts.push(await buildUsageAttempt("empty_response"));
          sameModelRetried = true;
          warnRecoveryAttempt(
            "empty_response",
            attemptConfig,
            attemptConfig,
            "Model produced no visible output, retrying",
          );
          continue;
        }

        if (index < attemptConfigs.length - 1 && !visibleOutputStarted) {
          usageAttempts.push(await buildUsageAttempt("empty_response"));
          sameModelRetried = false;
          warnRecoveryAttempt(
            "empty_response",
            attemptConfig,
            attemptConfigs[index + 1],
            "Model produced no visible output, falling back",
          );
          index++;
          continue;
        }

        // No more attempts — fall through to return empty response
        finalStatusReason = "empty_response";
      }

      const finalAttempt = await buildUsageAttempt(finalStatusReason);
      const usage = finalAttempt.usage;
      const cost = finalAttempt.cost;
      const allUsageAttempts: LLMUsageAttempt[] = [
        ...usageAttempts,
        finalAttempt,
      ];
      const totalTokens = usage.totalTokens ??
        await countTokens(attemptMessages, parsed.cleanResponse);
      const usageFinalized = finalAttempt.usageFinalized;

      return {
        prompt: attemptMessages,
        answer: parsed.cleanResponse,
        ...(reasoning && { reasoning }),
        tokens: totalTokens,
        finishReason: streamResult.finishReason,
        usage,
        usageAttempts: allUsageAttempts,
        ...(usageFinalized ? { usageFinalized } : {}),
        ...(cost ? { cost } : {}),
        provider: attemptProvider,
        model: attemptConfig.model,
        ...(parsed.toolCalls.length > 0 && { toolCalls: parsed.toolCalls }),
        ...(Object.keys(parsed.extractedTags).length > 0 && {
          extractedTags: parsed.extractedTags,
        }),
        metadata: {
          provider: attemptProvider,
          timestamp: new Date().toISOString(),
          messageCount: request.messages.length,
        },
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }

      lastError = error;
      lastRecoveryReason = classifyLLMError(error);
      sameModelRetried = false;
      const failedStatusReason = toUsageStatusReason(lastRecoveryReason);
      const failedUsage = await estimateUsage(
        attemptMessages,
        attemptVisibleOutput,
        usageStatusForReason(failedStatusReason),
        failedStatusReason ? { statusReason: failedStatusReason } : undefined,
      );
      const failedCost = await estimateUsageCost(attemptConfig, failedUsage);
      usageAttempts.push({
        attemptId,
        provider: attemptProvider,
        model: attemptConfig.model,
        usage: failedUsage,
        ...(failedCost ? { cost: failedCost } : {}),
        visibleOutputStarted: attemptVisibleOutputStarted,
      });

      attempts.push({
        provider: attemptProvider,
        model: attemptConfig.model,
        reason: classifyLLMError(error),
        status: getErrorStatus(error),
        message: getErrorMessage(error),
      });

      if (visibleOutputStarted) {
        const answer = sanitizeUserFacingText(recoveryPrefix);
        return {
          prompt: attemptMessages,
          answer,
          tokens: failedUsage.totalTokens ??
            await countTokens(attemptMessages, answer),
          finishReason: "error",
          usage: failedUsage,
          usageAttempts: [...usageAttempts],
          ...(failedCost ? { cost: failedCost } : {}),
          provider: attemptProvider,
          model: attemptConfig.model,
          metadata: {
            provider: attemptProvider,
            timestamp: new Date().toISOString(),
            messageCount: request.messages.length,
          },
        };
      }

      if (index < attemptConfigs.length - 1) {
        warnRecoveryAttempt(
          lastRecoveryReason,
          attemptConfig,
          attemptConfigs[index + 1],
          getErrorMessage(error),
        );
      }

      index++;
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
      visibleStreamStarted: visibleOutputStarted,
      usageAttempts,
      cause: lastError,
    });
  }

  throw new Error(
    "LLM chat exhausted all attempts without returning a response",
  );
}

export * from "@/runtime/llm/types.ts";
