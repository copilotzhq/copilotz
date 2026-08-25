import type { ContentInput, ContentSequence } from "@copilotz/copilotz/content";
import type {
  ActionInvocationMetadata,
  RuntimeCollections,
  RuntimeIdentity,
} from "@copilotz/copilotz/actions";

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

export type LlmBuiltinProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepseek"
  | "minimax"
  | "ollama";

export type LlmCredentialSource =
  | "connected_account"
  | "service_api_key"
  | "environment"
  | "explicit";

/** Runtime-only diagnostics which never cross the durable Action boundary. */
export type LlmRuntimeDiagnostics = Readonly<{
  enabled?: boolean;
  credentialSource?: LlmCredentialSource;
}>;

/** Stable identity of the reusable credential being resolved. */
export type LlmCredentialExecution = Readonly<{
  credential: string;
}>;

/**
 * The deliberately narrow, trusted runtime view available to a credential
 * resolver. It permits tenant/user-scoped collection lookups without handing
 * a credential policy the ability to invoke Actions or publish content.
 */
export type LlmCredentialContext = Readonly<{
  namespace: string;
  operationKey: string;
  identity: RuntimeIdentity;
  action: Readonly<{
    id: string;
    runId: string;
    parentRunId?: string;
    metadata: ActionInvocationMetadata;
  }>;
  collections: RuntimeCollections;
  signal: AbortSignal;
  now(): Date;
}>;

/** Runtime-only result from a credential resolver. */
export type LlmCredentialResolution =
  | Readonly<{
    available: true;
    apiKey: string;
    extraHeaders?: Readonly<Record<string, string>>;
  }>
  | Readonly<{
    available: true;
    apiKey?: string;
    extraHeaders: Readonly<Record<string, string>>;
  }>
  | Readonly<{
    available: false;
    reason?: string;
  }>;

/**
 * Reusable process-local credentials for one built-in provider. Static values
 * are useful for service keys; `resolve` supports connected accounts safely.
 */
type LlmStaticCredentialResource =
  | Readonly<{
    provider: LlmBuiltinProvider;
    apiKey: string;
    extraHeaders?: Readonly<Record<string, string>>;
    resolve?: never;
  }>
  | Readonly<{
    provider: LlmBuiltinProvider;
    apiKey?: string;
    extraHeaders: Readonly<Record<string, string>>;
    resolve?: never;
  }>;

export type LlmCredentialResource =
  | LlmStaticCredentialResource
  | Readonly<{
    provider: LlmBuiltinProvider;
    resolve(
      context: LlmCredentialContext,
      execution: LlmCredentialExecution,
    ): LlmCredentialResolution | Promise<LlmCredentialResolution>;
    apiKey?: never;
    extraHeaders?: never;
  }>;

/** Atomic selection and configuration of one first-party provider model. */
export type LlmBuiltinModelResource<
  TOptions extends LlmJsonObject = LlmJsonObject,
> = Readonly<{
  provider: LlmBuiltinProvider;
  model: string;
  /** Alias of one reusable `resources.llmCredentials` entry. */
  credentials?: string;
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Readonly<Record<string, string>>;
  options?: TOptions;
  runtimeDiagnostics?: LlmRuntimeDiagnostics;
  adapter?: never;
}>;

/** Selection of an application-defined executable Adapter and provider model. */
export type LlmCustomModelResource<
  TOptions extends LlmJsonObject = LlmJsonObject,
> = Readonly<{
  adapter: string;
  model: string;
  options?: TOptions;
  provider?: never;
  apiKey?: never;
  baseUrl?: never;
  extraHeaders?: never;
  runtimeDiagnostics?: never;
  credentials?: never;
}>;

export type ModelResource<
  TOptions extends LlmJsonObject = LlmJsonObject,
> = LlmBuiltinModelResource<TOptions> | LlmCustomModelResource<TOptions>;

export type LlmToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema?: LlmJsonObject;
}>;

/** One executable stage within a provider-neutral tool-call branch. */
export type LlmToolPipelineToolStage = Readonly<{
  type: "tool";
  /** Framework-owned correlation id for this executable stage. */
  id: string;
  action: string;
  input: LlmJsonObject;
}>;

/** A pure JSON transform applied between executable tool stages. */
export type LlmToolPipelineJqStage = Readonly<{
  type: "jq";
  filter: string;
}>;

export type LlmToolPipelineStage =
  | LlmToolPipelineToolStage
  | LlmToolPipelineJqStage;

/**
 * One sequential branch of a tool-call response. Separate LlmToolCalls are
 * parallel branches in provider order; stages in this pipeline are sequential.
 */
export type LlmToolPipeline = Readonly<{
  id: string;
  stages: readonly [LlmToolPipelineToolStage, ...LlmToolPipelineStage[]];
}>;

/** Provider-neutral, JSON-safe root tool call returned by an LLM. */
export type LlmToolCall = Readonly<{
  id: string;
  action: string;
  input: LlmJsonObject;
  /**
   * Optional for backwards-compatible history. When present, its first tool
   * stage is this root call; subsequent stages form a sequential branch.
   */
  pipeline?: LlmToolPipeline;
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
  /** Non-empty provider candidate list, attempted in exact caller order. */
  models: readonly [string, ...string[]];
  mode: LlmMode;
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
  /** True only when the Adapter reported a provider request actually began. */
  providerRequest: boolean;
  /** Model Resource alias selected for this provider attempt. */
  model: string;
  /** Built-in provider name or custom Adapter alias. */
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
  /** Built-in provider name or selected custom LLM Adapter alias. */
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
  /** Built-in provider name or selected custom LLM Adapter alias. */
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

/**
 * Validates and freezes one custom executable Adapter. First-party providers
 * are configured directly by {@link LlmBuiltinModelResource} values instead.
 */
export function normalizeLlmAdapter<const TAdapter extends LlmAdapter>(
  adapter: TAdapter,
): TAdapter {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("Custom LLM Adapter must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(adapter);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Custom LLM Adapter must be a plain object.");
  }
  const keys = Reflect.ownKeys(adapter);
  if (keys.length !== 1 || keys[0] !== "call") {
    throw new TypeError("Custom LLM Adapter may only define call(input).");
  }
  const descriptor = Object.getOwnPropertyDescriptor(adapter, "call");
  if (
    !descriptor || !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError("Custom LLM Adapter requires call(input).");
  }
  return Object.freeze({ call: descriptor.value }) as TAdapter;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Model ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function plainDataEntries(
  value: unknown,
  path: string,
): readonly (readonly [string, unknown])[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol fields.`);
    }
    if (key === "__proto__") {
      throw new TypeError(`${path} must not contain '__proto__'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data field.`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
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
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${path} must be a plain JSON array.`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
          throw new TypeError(`${path} must not contain symbol fields.`);
        }
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`${path} must not contain tagged array fields.`);
        }
      }
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path} must be a dense data array.`);
        }
        return canonicalJson(descriptor.value, `${path}[${index}]`, active);
      }));
    }
    const entries = plainDataEntries(value, path)
      .map(([key, child]) =>
        [
          key,
          canonicalJson(child, `${path}.${key}`, active),
        ] as const
      )
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    active.delete(value);
  }
}

const BUILTIN_PROVIDERS = new Set<LlmBuiltinProvider>([
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepseek",
  "minimax",
  "ollama",
]);

function builtinProvider(value: unknown, path: string): LlmBuiltinProvider {
  if (
    typeof value !== "string" ||
    !BUILTIN_PROVIDERS.has(value as LlmBuiltinProvider)
  ) {
    throw new TypeError(`${path} must be a built-in LLM provider.`);
  }
  return value as LlmBuiltinProvider;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, field);
}

function headerRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.freeze(Object.fromEntries(
    plainDataEntries(value, path).map(([key, entry]) => {
      if (!key.trim() || typeof entry !== "string") {
        throw new TypeError(
          `${path} requires non-empty names and string values.`,
        );
      }
      return [key, entry];
    }),
  ));
}

/** Validates and freezes one reusable process-local credential Resource. */
export function normalizeLlmCredential(
  resource: LlmCredentialResource,
): LlmCredentialResource {
  const record = Object.fromEntries(
    plainDataEntries(resource, "LLM credential resource"),
  ) as Readonly<Record<string, unknown>>;
  const dynamic = record.resolve !== undefined;
  const allowed = dynamic
    ? new Set(["provider", "resolve"])
    : new Set(["provider", "apiKey", "extraHeaders"]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra) {
    throw new TypeError(`Unknown LLM credential resource field '${extra}'.`);
  }
  const provider = builtinProvider(record.provider, "LLM credential provider");
  if (dynamic) {
    if (typeof record.resolve !== "function") {
      throw new TypeError("LLM credential resolve must be a function.");
    }
    return Object.freeze({
      provider,
      resolve: record.resolve as (
        context: LlmCredentialContext,
        execution: LlmCredentialExecution,
      ) => LlmCredentialResolution | Promise<LlmCredentialResolution>,
    }) as LlmCredentialResource;
  }
  const apiKey = optionalText(record.apiKey, "LLM credential apiKey");
  const extraHeaders = headerRecord(
    record.extraHeaders,
    "LLM credential extraHeaders",
  );
  if (apiKey === undefined && extraHeaders === undefined) {
    throw new TypeError(
      "LLM credential resource requires apiKey, extraHeaders, or resolve.",
    );
  }
  return Object.freeze({
    provider,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(extraHeaders === undefined ? {} : { extraHeaders }),
  }) as LlmCredentialResource;
}

/**
 * Optional convenience for dynamic Model declarations. Equivalent plain
 * objects remain canonical; this helper only validates, normalizes, and
 * freezes one value and performs no registration.
 */
export function normalizeModel<TOptions extends LlmJsonObject = LlmJsonObject>(
  resource: ModelResource<TOptions>,
): ModelResource<TOptions> {
  const record = Object.fromEntries(
    plainDataEntries(resource, "Model resource"),
  ) as Readonly<Record<string, unknown>>;
  const builtin = Object.hasOwn(record, "provider");
  const allowed = builtin
    ? new Set([
      "provider",
      "model",
      "credentials",
      "apiKey",
      "baseUrl",
      "extraHeaders",
      "options",
      "runtimeDiagnostics",
    ])
    : new Set(["adapter", "model", "options"]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra) throw new TypeError(`Unknown Model resource field '${extra}'.`);

  const model = requiredText(record.model, "model");
  const options = record.options === undefined
    ? undefined
    : canonicalJson(record.options, "Model options");
  if (
    options !== undefined && (Array.isArray(options) || options === null ||
      typeof options !== "object")
  ) {
    throw new TypeError("Model options must be a plain JSON object.");
  }
  if (!builtin) {
    const adapter = requiredText(record.adapter, "adapter");
    return Object.freeze({
      adapter,
      model,
      ...(options ? { options: options as TOptions } : {}),
    });
  }

  const provider = builtinProvider(record.provider, "Model provider");
  const credentials = optionalText(record.credentials, "credentials");
  const apiKey = optionalText(record.apiKey, "apiKey");
  const baseUrl = optionalText(record.baseUrl, "baseUrl");
  if (
    credentials !== undefined &&
    (apiKey !== undefined || record.extraHeaders !== undefined)
  ) {
    throw new TypeError(
      "Model credentials cannot be combined with inline apiKey or extraHeaders.",
    );
  }

  const extraHeaders = headerRecord(record.extraHeaders, "Model extraHeaders");

  let runtimeDiagnostics: LlmRuntimeDiagnostics | undefined;
  if (record.runtimeDiagnostics !== undefined) {
    const diagnostics = Object.fromEntries(plainDataEntries(
      record.runtimeDiagnostics,
      "Model runtimeDiagnostics",
    ));
    const diagnosticExtra = Object.keys(diagnostics).find((key) =>
      key !== "enabled" && key !== "credentialSource"
    );
    if (diagnosticExtra) {
      throw new TypeError(
        `Unknown Model runtimeDiagnostics field '${diagnosticExtra}'.`,
      );
    }
    if (
      diagnostics.enabled !== undefined &&
      typeof diagnostics.enabled !== "boolean"
    ) {
      throw new TypeError("Model runtimeDiagnostics.enabled must be boolean.");
    }
    const credentialSources = new Set<LlmCredentialSource>([
      "connected_account",
      "service_api_key",
      "environment",
      "explicit",
    ]);
    if (
      diagnostics.credentialSource !== undefined &&
      (typeof diagnostics.credentialSource !== "string" ||
        !credentialSources.has(
          diagnostics.credentialSource as LlmCredentialSource,
        ))
    ) {
      throw new TypeError(
        "Model runtimeDiagnostics.credentialSource is invalid.",
      );
    }
    runtimeDiagnostics = Object.freeze({
      ...(diagnostics.enabled === undefined
        ? {}
        : { enabled: diagnostics.enabled as boolean }),
      ...(diagnostics.credentialSource === undefined ? {} : {
        credentialSource: diagnostics.credentialSource as LlmCredentialSource,
      }),
    });
  }

  return Object.freeze({
    provider,
    model,
    ...(credentials === undefined ? {} : { credentials }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(extraHeaders === undefined ? {} : { extraHeaders }),
    ...(options ? { options: options as TOptions } : {}),
    ...(runtimeDiagnostics === undefined ? {} : { runtimeDiagnostics }),
  });
}
