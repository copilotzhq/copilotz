import { bytesToBase64, toDataUrl } from "@copilotz/copilotz/content";

import {
  type LlmAdapter,
  type LlmAdapterAttempt,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterContentPart,
  type LlmAdapterFrame,
  type LlmAdapterResult,
  type LlmJsonObject,
  type LlmJsonValue,
  type LlmToolCall,
  type LlmToolDefinition,
  type LlmUsage,
} from "../contracts.ts";
import { LLMProviderError } from "../internal/errors.ts";
import { chat } from "../internal/orchestrator.ts";
import type {
  ChatContentPart,
  ChatMessage,
  ChatResponse,
  LLMRuntimeDiagnostics,
  LLMUsageAttempt,
  ProviderConfig,
  ProviderFactory,
  ProviderName,
  TokenUsage,
  ToolDefinition,
  ToolInvocation,
} from "../internal/types.ts";

/**
 * Runtime-only provider configuration captured by a concrete Adapter value.
 * Credentials and transport configuration never enter a Model Resource or an
 * LLM Action input/output.
 */
export type LlmProviderAdapterConfig = Readonly<{
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Readonly<Record<string, string>>;
  runtimeDiagnostics?: Readonly<LLMRuntimeDiagnostics>;
  /** Non-secret defaults applied before each Model/Action options overlay. */
  options?: LlmJsonObject;
}>;

const SAFE_PROVIDER_OPTIONS = new Set([
  "attemptTimeoutMs",
  "candidateCount",
  "estimateCost",
  "firstTokenTimeoutMs",
  "frequencyPenalty",
  "geminiThinkingConfig",
  "limitEstimatedInputTokens",
  "maxCompletionTokens",
  "maxTokens",
  "metadata",
  "numCtx",
  "openaiApi",
  "openaiReasoningSummary",
  "outputReasoning",
  "presencePenalty",
  "pricingModelId",
  "reasoningEffort",
  "repeatPenalty",
  "responseMimeType",
  "responseType",
  "seed",
  "stop",
  "stopSequences",
  "streamIdleTimeoutMs",
  "temperature",
  "toolSystemPromptVariant",
  "topK",
  "topP",
  "totalTimeoutMs",
  "user",
  "verbosity",
]);

const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

type FrameChannel = Readonly<{
  frames: ReadableStream<LlmAdapterFrame>;
  signal: AbortSignal;
  emit(frame: LlmAdapterFrame): void;
  close(): void;
  fail(error: unknown): void;
  dispose(): void;
}>;

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      "LLM Adapter " + field + " must be a non-empty string.",
    );
  }
  return value.trim();
}

function cloneStringRecord(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  return value ? { ...value } : undefined;
}

function runtimeOptions(value: LlmJsonObject | undefined): ProviderConfig {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!SAFE_PROVIDER_OPTIONS.has(key)) {
      throw new TypeError(
        "Unsupported durable LLM provider option '" + key +
          "'. Transport and credentials belong to Adapter construction.",
      );
    }
    result[key] = entry;
  }
  return result as ProviderConfig;
}

function captureJson(
  value: LlmJsonValue,
  active = new Set<object>(),
): LlmJsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("LLM Adapter options require finite JSON numbers.");
    }
    return value;
  }
  if (active.has(value)) {
    throw new TypeError("LLM Adapter options must not contain cycles.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => captureJson(entry, active)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("LLM Adapter options must be plain JSON objects.");
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map((
          [key, entry],
        ) => [key, captureJson(entry, active)]),
      ),
    );
  } finally {
    active.delete(value);
  }
}

function extensionFromMediaType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return undefined;
  const known: Readonly<Record<string, string>> = {
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  };
  return known[normalized] ??
    normalized.split("/")[1]?.replace(/^x-/, "").replace(/[^a-z0-9]+/g, "");
}

function adapterPartToChatPart(
  part: LlmAdapterContentPart,
): ChatContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "json":
      return {
        type: "text",
        text: JSON.stringify(part.value) ?? "null",
      };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: toDataUrl(part.bytes, part.mediaType),
        },
      };
    case "audio": {
      const format = extensionFromMediaType(part.mediaType);
      return {
        type: "input_audio",
        input_audio: {
          data: bytesToBase64(part.bytes),
          ...(format ? { format } : {}),
          ...(part.name ? { filename: part.name } : {}),
        },
      };
    }
    case "video":
      return {
        type: "video",
        video: {
          url: toDataUrl(part.bytes, part.mediaType),
          mime_type: part.mediaType,
        },
      };
    case "file":
      return {
        type: "file",
        file: {
          file_data: toDataUrl(part.bytes, part.mediaType),
          mime_type: part.mediaType,
          ...(part.name ? { filename: part.name } : {}),
        },
      };
  }
}

function toolInvocation(call: LlmToolCall): ToolInvocation {
  return {
    id: call.id,
    tool: { id: call.action },
    args: JSON.stringify(call.input),
  };
}

function adapterMessageToChatMessage(
  message: LlmAdapterCallInput["request"]["messages"][number],
): ChatMessage {
  const content = message.content.map(adapterPartToChatPart);
  const common = {
    content,
    ...(message.name ? { senderId: message.name } : {}),
    ...(message.metadata
      ? { metadata: message.metadata as Record<string, unknown> }
      : {}),
  };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...common,
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map(toolInvocation) }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool_result",
      ...common,
      tool_call_id: message.toolCallId,
    };
  }
  return { role: message.role, ...common };
}

function toolDefinition(definition: LlmToolDefinition): ToolDefinition {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      inputTypes: definition.inputSchema
        ? JSON.stringify(definition.inputSchema, null, 2)
        : "{}",
    },
  };
}

function createChatRequest(
  input: LlmAdapterCallInput,
  signal: AbortSignal,
) {
  const messages = input.request.messages.map(adapterMessageToChatMessage);
  return {
    messages: input.request.instructions
      ? [
        { role: "system" as const, content: input.request.instructions },
        ...messages,
      ]
      : messages,
    ...(input.request.tools
      ? { tools: input.request.tools.map(toolDefinition) }
      : {}),
    signal,
  };
}

function plainJsonObject(value: unknown, field: string): LlmJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(field + " must be a JSON object.");
  }
  return value as LlmJsonObject;
}

function normalizeToolCall(call: ToolInvocation): LlmToolCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.args);
  } catch (error) {
    throw new TypeError(
      "LLM tool call '" + call.id + "' contains invalid JSON input.",
      { cause: error },
    );
  }
  return Object.freeze({
    id: requiredText(call.id, "tool call id"),
    action: requiredText(call.tool.id, "tool call action"),
    input: plainJsonObject(
      parsed,
      "LLM tool call '" + call.id + "' input",
    ),
  });
}

function normalizeUsage(
  usage: TokenUsage | undefined,
  cost?: ChatResponse["cost"],
): LlmUsage | undefined {
  if (!usage && !cost) return undefined;
  return Object.freeze({
    ...(usage?.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage?.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(usage?.cacheReadInputTokens !== undefined
      ? { cachedInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage?.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
    ...(cost
      ? {
        cost: {
          amount: cost.totalCostUsd,
          currency: cost.currency,
        },
      }
      : {}),
  });
}

function boundedCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

function sanitizedAttemptError(
  attempt: LLMUsageAttempt,
): LlmAdapterAttempt["error"] {
  const code = boundedCode(attempt.error?.details?.code) ??
    boundedCode(attempt.error?.reason) ??
    boundedCode(attempt.usage.statusReason);
  return Object.freeze({
    ...(code ? { code } : {}),
    message: code
      ? `Provider attempt did not complete (${code}).`
      : "Provider attempt did not complete.",
  });
}

function normalizeInternalAttempt(
  attempt: LLMUsageAttempt,
  finalized?: Awaited<LLMUsageAttempt["usageFinalized"]>,
  finishReason?: string,
): LlmAdapterAttempt {
  const status = attempt.status === "completed" ? "completed" : "failed";
  const usage = normalizeUsage(
    finalized?.usage ?? attempt.usage,
    finalized?.cost ?? attempt.cost,
  );
  return Object.freeze({
    status,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(status === "failed" ? { error: sanitizedAttemptError(attempt) } : {}),
    ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
  });
}

async function finalizedAttempt(
  attempt: LLMUsageAttempt,
): Promise<Awaited<LLMUsageAttempt["usageFinalized"]>> {
  if (!attempt.usageFinalized) return undefined;
  try {
    return await attempt.usageFinalized;
  } catch {
    // Accounting refinement must not invalidate an otherwise usable response.
    return undefined;
  }
}

async function normalizeResult(
  response: ChatResponse,
): Promise<LlmAdapterResult> {
  const sourceAttempts = response.usageAttempts ?? [];
  let attempts: readonly LlmAdapterAttempt[];
  let finishReason = response.finishReason ?? undefined;
  if (sourceAttempts.length > 0) {
    const normalized: LlmAdapterAttempt[] = [];
    for (const [index, attempt] of sourceAttempts.entries()) {
      const finalized = await finalizedAttempt(attempt);
      const attemptFinishReason = index === sourceAttempts.length - 1
        ? finalized?.finishReason ?? finishReason
        : finalized?.finishReason ?? undefined;
      normalized.push(normalizeInternalAttempt(
        attempt,
        finalized,
        attemptFinishReason ?? undefined,
      ));
      if (index === sourceAttempts.length - 1 && finalized?.finishReason) {
        finishReason = finalized.finishReason;
      }
    }
    attempts = Object.freeze(normalized);
  } else {
    let finalized: Awaited<ChatResponse["usageFinalized"]>;
    try {
      finalized = await response.usageFinalized;
    } catch {
      // Keep the already-settled semantic response and best available usage.
      finalized = undefined;
    }
    const usage = normalizeUsage(
      finalized?.usage ?? response.usage,
      finalized?.cost ?? response.cost,
    );
    finishReason = finalized?.finishReason ?? finishReason;
    attempts = Object.freeze([Object.freeze({
      status: "completed" as const,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(finalized?.finalizedAt ? { finishedAt: finalized.finalizedAt } : {}),
    })]);
  }
  return Object.freeze({
    content: { type: "text" as const, text: response.answer },
    ...(response.reasoning
      ? {
        reasoning: {
          type: "text" as const,
          text: response.reasoning,
        },
      }
      : {}),
    ...(response.toolCalls
      ? { toolCalls: response.toolCalls.map(normalizeToolCall) }
      : {}),
    attempts,
    ...(finishReason ? { finishReason } : {}),
  });
}

async function normalizeFailureAttempts(
  error: LLMProviderError,
): Promise<readonly LlmAdapterAttempt[]> {
  return Object.freeze(
    await Promise.all(
      error.usageAttempts.map(async (attempt) =>
        normalizeInternalAttempt(attempt, await finalizedAttempt(attempt))
      ),
    ),
  );
}

async function normalizedProviderFailure(error: unknown): Promise<unknown> {
  if (!(error instanceof LLMProviderError)) return error;
  const code = boundedCode(error.providerError?.code) ??
    boundedCode(error.reason);
  return new LlmAdapterCallError(
    code ? `LLM provider call failed (${code}).` : "LLM provider call failed.",
    {
      attempts: await normalizeFailureAttempts(error),
      cause: error,
      name: error.name,
    },
  );
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException(
    typeof reason === "string" && reason ? reason : "LLM request aborted",
    "AbortError",
  );
}

function frameChannel(sourceSignal: AbortSignal): FrameChannel {
  const abort = new AbortController();
  let controller: ReadableStreamDefaultController<LlmAdapterFrame> | undefined;
  let settled = false;
  const forwardAbort = () => {
    if (!abort.signal.aborted) abort.abort(sourceSignal.reason);
  };
  if (sourceSignal.aborted) forwardAbort();
  else sourceSignal.addEventListener("abort", forwardAbort, { once: true });

  const frames = new ReadableStream<LlmAdapterFrame>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      settled = true;
      if (!abort.signal.aborted) abort.abort(reason);
    },
  });

  return Object.freeze({
    frames,
    signal: abort.signal,
    emit(frame) {
      if (!settled) controller?.enqueue(frame);
    },
    close() {
      if (settled) return;
      settled = true;
      controller?.close();
    },
    fail(error) {
      if (settled) return;
      settled = true;
      controller?.error(error);
    },
    dispose() {
      sourceSignal.removeEventListener("abort", forwardAbort);
    },
  });
}

function providerConfig(
  provider: ProviderName,
  input: LlmAdapterCallInput,
  captured: LlmProviderAdapterConfig,
): ProviderConfig {
  return {
    ...runtimeOptions(captured.options),
    ...runtimeOptions(input.options),
    provider,
    model: requiredText(input.providerModel, "provider model"),
    apiKey: captured.apiKey,
    baseUrl: captured.baseUrl,
    extraHeaders: cloneStringRecord(captured.extraHeaders),
    runtimeDiagnostics: captured.runtimeDiagnostics
      ? { ...captured.runtimeDiagnostics }
      : undefined,
    fallbacks: undefined,
  };
}

/** Private bridge from the mature wire protocol runner to the final contract. */
export function createProviderAdapter(
  provider: ProviderName,
  configuration: LlmProviderAdapterConfig,
  protocol: ProviderFactory,
): LlmAdapter {
  const options = configuration.options
    ? captureJson(configuration.options) as LlmJsonObject
    : undefined;
  runtimeOptions(options);
  const captured = Object.freeze({
    apiKey: configuration.apiKey,
    baseUrl: configuration.baseUrl,
    extraHeaders: cloneStringRecord(configuration.extraHeaders),
    runtimeDiagnostics: configuration.runtimeDiagnostics
      ? Object.freeze({ ...configuration.runtimeDiagnostics })
      : undefined,
    options,
  });

  return Object.freeze({
    call(input) {
      const channel = frameChannel(input.signal);
      const encoder = new TextEncoder();
      const result = (async () => {
        try {
          if (input.input !== undefined) {
            throw new TypeError(
              provider + " Adapter does not implement live input streaming.",
            );
          }
          if (input.mode !== "generate") {
            throw new TypeError(
              provider + " Adapter does not implement LLM session mode.",
            );
          }
          if (channel.signal.aborted) {
            throw abortError(channel.signal.reason);
          }
          const response = await chat(
            {
              ...createChatRequest(input, channel.signal),
              onToolCallDelta(delta) {
                channel.emit({
                  lane: "tool-calls",
                  mediaType: "application/x-ndjson",
                  bytes: encoder.encode(
                    JSON.stringify({
                      ...delta,
                      action: delta.toolName,
                    }) + "\n",
                  ),
                });
              },
            },
            providerConfig(provider, input, captured),
            {},
            (chunk, options) => {
              channel.emit({
                lane: options?.isReasoning ? "reasoning" : "content",
                mediaType: TEXT_MEDIA_TYPE,
                bytes: encoder.encode(chunk),
              });
            },
            { [provider]: protocol },
            { hasExternalFallback: input.fallbackAvailable },
          );
          if (channel.signal.aborted) {
            throw abortError(channel.signal.reason);
          }
          return await normalizeResult(response);
        } catch (error) {
          const failure = channel.signal.aborted
            ? abortError(channel.signal.reason)
            : await normalizedProviderFailure(error);
          channel.fail(failure);
          throw failure;
        } finally {
          channel.close();
          channel.dispose();
        }
      })();
      return Object.freeze({ frames: channel.frames, result });
    },
  });
}
