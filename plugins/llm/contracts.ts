import type { ContentInput, ContentSequence } from "@copilotz/copilotz/content";

/** JSON values that may cross the durable LLM Action boundary. */
export type LlmJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LlmJsonValue[]
  | LlmJsonObject;

export type LlmJsonObject = Readonly<{
  [key: string]: LlmJsonValue;
}>;

export type LlmMode = "generate" | "session";

/** Application-owned selection of one provider Adapter and provider model. */
export type ModelResource<
  TOptions extends LlmJsonObject = LlmJsonObject,
> = Readonly<{
  adapter: string;
  model: string;
  mode?: LlmMode;
  options?: TOptions;
  fallbacks?: readonly string[];
}>;

export type LlmToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema?: LlmJsonObject;
}>;

/** Provider-neutral, JSON-safe tool call returned by an LLM. */
export type LlmToolCall = Readonly<{
  id: string;
  action: string;
  input: LlmJsonObject;
}>;

type LlmMessageBase = Readonly<{
  content: ContentSequence;
  name?: string;
  metadata?: LlmJsonObject;
}>;

/** Durable, provider-neutral history supplied to the `llm.call` Action. */
export type LlmMessage =
  | (LlmMessageBase & Readonly<{ role: "system" | "user" }>)
  | (
    & LlmMessageBase
    & Readonly<{
      role: "assistant";
      toolCalls?: readonly LlmToolCall[];
    }>
  )
  | (
    & LlmMessageBase
    & Readonly<{
      role: "tool";
      toolCallId: string;
    }>
  );

export type LlmRequest = Readonly<{
  messages: readonly LlmMessage[];
  tools?: readonly LlmToolDefinition[];
  instructions?: string;
}>;

/** Optional description for the progressive output produced by `llm.call`. */
export type LlmStreamDescriptor = Readonly<{
  id?: string;
  metadata?: LlmJsonObject;
}>;

/** Durable input to the provider-neutral `llm.call` Action. */
export type LlmCallInput = Readonly<{
  model: string;
  request: LlmRequest;
  stream?: LlmStreamDescriptor;
  inputStreamId?: string;
  options?: LlmJsonObject;
}>;

export type LlmCost = Readonly<{
  amount: number;
  currency: string;
}>;

export type LlmUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  cost?: LlmCost;
}>;

export type LlmAttemptStatus = "completed" | "failed" | "cancelled";

export type LlmAttemptUsage = Readonly<{
  id: string;
  index: number;
  adapter: string;
  providerModel: string;
  status: LlmAttemptStatus;
  usage?: LlmUsage;
  finishReason?: string;
  error?: Readonly<{
    code?: string;
    message: string;
  }>;
  startedAt?: string;
  finishedAt?: string;
}>;

/** Settled, JSON-safe output persisted by the `llm.call` Action lifecycle. */
export type LlmCallOutput = Readonly<{
  model: string;
  adapter: string;
  providerModel: string;
  content: ContentSequence;
  reasoning?: ContentSequence;
  toolCalls?: readonly LlmToolCall[];
  usage?: LlmUsage;
  attempts?: readonly LlmAttemptUsage[];
  finishReason?: string;
}>;

/**
 * A resolved provider-neutral part. Unlike durable `LlmMessage.content`, this
 * may contain bytes, but can no longer contain a ContentRef or shorthand text.
 */
export type LlmAdapterContentPart = Readonly<
  Extract<ContentInput, { type: string }>
>;

type LlmAdapterMessageBase = Readonly<{
  content: readonly LlmAdapterContentPart[];
  name?: string;
  metadata?: LlmJsonObject;
}>;

export type LlmAdapterMessage =
  | (LlmAdapterMessageBase & Readonly<{ role: "system" | "user" }>)
  | (
    & LlmAdapterMessageBase
    & Readonly<{
      role: "assistant";
      toolCalls?: readonly LlmToolCall[];
    }>
  )
  | (
    & LlmAdapterMessageBase
    & Readonly<{
      role: "tool";
      toolCallId: string;
    }>
  );

/** Fully resolved request passed to an LLM Adapter. */
export type LlmAdapterRequest = Readonly<{
  messages: readonly LlmAdapterMessage[];
  tools?: readonly LlmToolDefinition[];
  instructions?: string;
}>;

export type LlmAdapterCallInput = Readonly<{
  /** Selected Model Resource alias. */
  model: string;
  /** Selected LLM Adapter alias. */
  adapter: string;
  /** Provider-specific model identifier from the selected Model Resource. */
  providerModel: string;
  mode: LlmMode;
  /** Whether `llm.call` has another validated Model candidate after this one. */
  fallbackAvailable: boolean;
  options: LlmJsonObject;
  request: LlmAdapterRequest;
  signal: AbortSignal;
  input?: ReadableStream<Uint8Array>;
}>;

/** Runtime-only progressive output; frames are never durable Action data. */
export type LlmAdapterFrame = Readonly<{
  lane: string;
  mediaType: string;
  bytes: Uint8Array;
}>;

/** Runtime-only, credential-safe accounting for one provider attempt. */
export type LlmAdapterAttempt = Readonly<{
  status: LlmAttemptStatus;
  usage?: LlmUsage;
  finishReason?: string;
  error?: Readonly<{
    code?: string;
    message: string;
  }>;
  startedAt?: string;
  finishedAt?: string;
}>;

/**
 * Runtime-only Adapter failure carrying only sanitized accounting. The cause is
 * never persisted; `llm.call` validates and re-identifies every attempt before
 * it crosses the durable boundary.
 */
export class LlmAdapterCallError extends Error {
  readonly attempts: readonly LlmAdapterAttempt[];

  constructor(
    message: string,
    options: Readonly<{
      attempts?: readonly LlmAdapterAttempt[];
      cause?: unknown;
      name?: string;
    }> = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : {
        cause: options.cause,
      },
    );
    this.name = options.name?.trim() || "LlmAdapterCallError";
    this.attempts = Object.freeze([...(options.attempts ?? [])]);
  }
}

/** Runtime-only normalized result which `llm.call` materializes before return. */
export type LlmAdapterResult = Readonly<{
  content: ContentInput | readonly ContentInput[];
  reasoning?: ContentInput | readonly ContentInput[];
  toolCalls?: readonly LlmToolCall[];
  /**
   * Non-empty provider-attempt history. An accepted partial result may contain
   * only failed attempts; Action lifecycle state records semantic completion.
   */
  attempts: readonly LlmAdapterAttempt[];
  finishReason?: string;
}>;

export type LlmInvocation = Readonly<{
  frames: ReadableStream<LlmAdapterFrame>;
  result: Promise<LlmAdapterResult>;
}>;

export type LlmAdapter = Readonly<{
  call(input: LlmAdapterCallInput): LlmInvocation;
}>;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Model ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function canonicalJson(
  value: unknown,
  path: string,
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
      throw new TypeError(`${path} must contain only finite JSON numbers.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON-safe values.`);
  }
  if (active.has(value)) {
    throw new TypeError(`${path} must not contain cycles.`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) =>
          canonicalJson(item, `${path}[${index}]`, active)
        ),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object.`);
    }
    const result: Record<string, LlmJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        active,
      );
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

/**
 * Optional convenience for dynamic Model declarations. Equivalent plain
 * objects remain canonical; this helper only validates, normalizes, and
 * freezes one value and performs no registration.
 */
export function defineModel<TOptions extends LlmJsonObject = LlmJsonObject>(
  resource: ModelResource<TOptions>,
): ModelResource<TOptions> {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new TypeError("Model resource must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(resource);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Model resource must be a plain object.");
  }
  const record = resource as Readonly<Record<string, unknown>>;
  const allowed = new Set(["adapter", "model", "mode", "options", "fallbacks"]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra) throw new TypeError(`Unknown Model resource field '${extra}'.`);

  const adapter = requiredText(record.adapter, "adapter");
  const model = requiredText(record.model, "model");
  const mode = record.mode;
  if (mode !== undefined && mode !== "generate" && mode !== "session") {
    throw new TypeError("Model mode must be 'generate' or 'session'.");
  }
  const options = record.options === undefined
    ? undefined
    : canonicalJson(record.options, "Model options");
  if (
    options !== undefined && (Array.isArray(options) || options === null ||
      typeof options !== "object")
  ) {
    throw new TypeError("Model options must be a plain JSON object.");
  }
  let fallbacks: readonly string[] | undefined;
  if (record.fallbacks !== undefined) {
    if (!Array.isArray(record.fallbacks)) {
      throw new TypeError("Model fallbacks must be an array of aliases.");
    }
    fallbacks = Object.freeze(
      record.fallbacks.map((fallback, index) =>
        requiredText(fallback, `fallback at index ${index}`)
      ),
    );
  }

  return Object.freeze({
    adapter,
    model,
    ...(mode ? { mode } : {}),
    ...(options ? { options: options as TOptions } : {}),
    ...(fallbacks ? { fallbacks } : {}),
  });
}
