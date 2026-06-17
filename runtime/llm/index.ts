import type {
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderFinishReason,
  ProviderName,
  ProviderRegistry,
  StreamCallback,
  TokenUsage,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { estimateUsageCost } from "@/runtime/llm/pricing.ts";
import { resolveProviderApiKey, toLLMConfig } from "@/runtime/llm/config.ts";
import {
  countTokens,
  createMockResponse,
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

function buildRecoveryCue(reason: string | null): string {
  switch (reason) {
    case "length":
      return "Previous response exceeded maximum output length. Continue where you left off. Be concise and break into smaller steps if needed.";
    case "timeout":
      return "Previous response was interrupted by a timeout. Continue where you left off. Be concise.";
    case "content_filter":
      return "Previous response was blocked by a content filter. Continue where you left off, rephrasing as needed.";
    case "error":
      return "Previous response was interrupted by a provider error. Continue where you left off.";
    case "empty_response":
      return "Previous attempt produced reasoning but no visible response. You must produce a concrete answer for the user.";
    case "malformed_tool_call":
      return `Your previous response attempted to call a tool in an unsupported format.

The only supported tool-call format is exactly:

<tool_calls>
{"name":"tool_name","arguments":{}}
</tool_calls>

Rules:
- Use one valid JSON object per line inside <tool_calls>.
- Each JSON object must contain exactly "name" and "arguments".
- "arguments" must be a JSON object.
- Do not use XML tool syntax such as <tool_call>, <invoke>, <parameter>, <function_call>, <tool_use>, <result>, or <tool_results>.
- Do not emit provider-native tool syntax.
- Do not emit tool result tags.
- Do not wrap the JSON in markdown fences.
- If you intended to call a tool, re-emit only the corrected <tool_calls> block.
- If you did not intend to call a tool, answer normally without any tool or result protocol.`;
    case "visible_reasoning_markup":
      return `Your previous response exposed private reasoning/thinking markup.

Do not emit <think>, <thought>, <thinking>, <reasoning>, <mm:think>, or any similar reasoning tags in visible output.

If you need to answer, provide only the final user-facing answer.
If you need to call a tool, use only the supported <tool_calls> JSON Lines format.`;
    default:
      return "Continue exactly where you left off. Do not repeat earlier content.";
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
  extractedReasoning: string[];
} {
  let cleanResponse = response;
  let toolCalls: ToolInvocation[] = [];
  let extractedTags: Record<string, string[]> = {};
  let extractedReasoning: string[] = [];

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

  return { cleanResponse, toolCalls, extractedTags, extractedReasoning };
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

/**
 * Unified AI Chat endpoint.
 *
 * Streams an LLM response through the configured provider. Recovers from
 * mid-stream failures and truncations by falling back to alternative
 * providers (or retrying the same model for output-length truncations).
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
  let recoveryPrefix = "";
  let lastRecoveryReason: string | null = null;
  let sameModelRetried = false;

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

    const trackedStream = stream
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 && !options?.isReasoning) {
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

      // Check for recoverable finish reasons (length, error, content_filter)
      if (
        streamResult.finishReason &&
        RECOVERABLE_FINISH_REASONS.has(streamResult.finishReason)
      ) {
        lastRecoveryReason = streamResult.finishReason;

        // For length: retry same model once — continuation context means
        // the model only needs to finish the remaining part.
        if (streamResult.finishReason === "length" && !sameModelRetried) {
          sameModelRetried = true;
          warnRecoveryAttempt(
            "length",
            attemptConfig,
            attemptConfig,
            "Retrying same model with continuation context",
          );
          continue;
        }

        // For all recoverable reasons: try next fallback if available
        if (index < attemptConfigs.length - 1) {
          sameModelRetried = false;
          warnRecoveryAttempt(
            streamResult.finishReason,
            attemptConfig,
            attemptConfigs[index + 1],
          );
          index++;
          continue;
        }

        // No more attempts — fall through to return what we have
      }

      // Success or exhausted recovery options — build response
      const fullContent = prefixBeforeAttempt + streamResult.content;
      const parsed = parseAssistantResponse(
        fullContent,
        extractedBlockTags,
        knownToolNames,
      );
      const reasoning = mergeReasoningParts(
        streamResult.reasoning,
        parsed.extractedReasoning,
      );

      // Detect a malformed tool-call attempt: the model emitted tool-call
      // markup (canonical or a native dialect) that produced no parseable call.
      // Correct it with a synthetic instruction and retry, then fall back —
      // rather than leaking protocol markup or silently dropping the call.
      const hasMalformedToolIntent = responseHasMalformedToolCallIntent(
        fullContent,
        knownToolNames,
      ) ||
        (parsed.toolCalls.length === 0 &&
          responseHasToolIntent(fullContent, knownToolNames));
      const hasVisibleReasoningMarkup = responseHasReasoningMarkup(fullContent);

      // Detect unintentional empty response: model produced no useful
      // output and didn't use any control action (tool calls, routing, etc.)
      const isUnintentionallyEmpty = parsed.cleanResponse.length === 0 &&
        parsed.toolCalls.length === 0 &&
        Object.keys(parsed.extractedTags).length === 0 &&
        !INTENTIONAL_EMPTY_PATTERN.test(fullContent);

      if (hasMalformedToolIntent) {
        // Discard the unparseable attempt entirely.
        recoveryPrefix = prefixBeforeAttempt;
        lastRecoveryReason = "malformed_tool_call";

        if (!sameModelRetried) {
          sameModelRetried = true;
          warnRecoveryAttempt(
            "malformed_tool_call",
            attemptConfig,
            attemptConfig,
            "Model emitted an unparseable tool call, retrying",
          );
          continue;
        }

        if (index < attemptConfigs.length - 1) {
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
      } else if (hasVisibleReasoningMarkup) {
        recoveryPrefix = prefixBeforeAttempt;
        lastRecoveryReason = "visible_reasoning_markup";

        if (!sameModelRetried) {
          sameModelRetried = true;
          warnRecoveryAttempt(
            "visible_reasoning_markup",
            attemptConfig,
            attemptConfig,
            "Model exposed reasoning markup, retrying",
          );
          continue;
        }

        if (index < attemptConfigs.length - 1) {
          sameModelRetried = false;
          warnRecoveryAttempt(
            "visible_reasoning_markup",
            attemptConfig,
            attemptConfigs[index + 1],
            "Model exposed reasoning markup, falling back",
          );
          index++;
          continue;
        }

        parsed.cleanResponse = sanitizeUserFacingText(parsed.cleanResponse);
      } else if (isUnintentionallyEmpty) {
        // Undo the accumulation from this attempt — no useful content
        recoveryPrefix = prefixBeforeAttempt;
        lastRecoveryReason = "empty_response";

        if (!sameModelRetried) {
          sameModelRetried = true;
          warnRecoveryAttempt(
            "empty_response",
            attemptConfig,
            attemptConfig,
            "Model produced no visible output, retrying",
          );
          continue;
        }

        if (index < attemptConfigs.length - 1) {
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
      }

      const usageStatus = streamResult.stoppedByLocalStop
        ? "locally_stopped"
        : "completed";
      const usageMetadata = streamResult.stoppedByLocalStop
        ? {
          statusReason: streamResult.localStopReason ?? "local_stop_sequence",
          ...(streamResult.localStopSequence
            ? { stopSequence: streamResult.localStopSequence }
            : {}),
        } satisfies Pick<TokenUsage, "statusReason" | "stopSequence">
        : undefined;
      const usage = normalizeProviderUsage(
        streamResult.usage,
        usageStatus,
        usageMetadata,
      ) ??
        await estimateUsage(
          attemptMessages,
          parsed.cleanResponse,
          usageStatus,
          usageMetadata,
        );
      const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
      const totalTokens = usage.totalTokens ??
        await countTokens(attemptMessages, parsed.cleanResponse);
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
              await countTokens(attemptMessages, parsed.cleanResponse),
            finishReason: finalized.finishReason,
            finalizedAt: new Date().toISOString(),
          };
        })
        : undefined;

      return {
        prompt: attemptMessages,
        answer: parsed.cleanResponse,
        ...(reasoning && { reasoning }),
        tokens: totalTokens,
        finishReason: streamResult.finishReason,
        usage,
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

      attempts.push({
        provider: attemptProvider,
        model: attemptConfig.model,
        reason: classifyLLMError(error),
        status: getErrorStatus(error),
        message: getErrorMessage(error),
      });

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
      cause: lastError,
    });
  }

  throw new Error(
    "LLM chat exhausted all attempts without returning a response",
  );
}

export * from "@/runtime/llm/types.ts";
