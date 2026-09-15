import type { ContentInput, ContentSequence } from "@copilotz/copilotz/content";
import type {
  ActionContentEntry,
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

/** Trusted Core turn identity, retained only while a built-in provider is called. */
export type LlmRuntimeExecutionIdentity = Readonly<{
  /** Opaque provider-scoped stable identity, never durable Action data. */
  cacheKey: string;
}>;

/** Stable identity of the connection being resolved. */
export type LlmConnectionExecution = Readonly<{
  connection: string;
}>;

/**
 * The deliberately narrow, trusted runtime view available to a credential
 * resolver. It permits tenant/user-scoped collection lookups without handing
 * a credential policy the ability to invoke Actions or publish content.
 */
export type LlmConnectionContext = Readonly<{
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
export type LlmAuthResolution =
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
export type LlmStaticAuth =
  | Readonly<{
    apiKey: string;
    extraHeaders?: Readonly<Record<string, string>>;
    resolve?: never;
  }>
  | Readonly<{
    apiKey?: string;
    extraHeaders: Readonly<Record<string, string>>;
    resolve?: never;
  }>;

/** Runtime-only authentication policy for a trusted Action invocation. */
export type LlmAuthResolver = (
  context: LlmConnectionContext,
  execution: LlmConnectionExecution,
) => LlmAuthResolution | Promise<LlmAuthResolution>;

export type LlmConnectionResource =
  | Readonly<{
    provider: LlmBuiltinProvider;
    adapter?: never;
    baseUrl?: string;
    auth:
      | LlmStaticAuth
      | Readonly<{
        resolve: LlmAuthResolver;
        apiKey?: never;
        extraHeaders?: never;
      }>;
    runtimeDiagnostics?: LlmRuntimeDiagnostics;
  }>
  | Readonly<{
    adapter: string;
    provider?: never;
    baseUrl?: never;
    auth?: never;
    runtimeDiagnostics?: never;
  }>;

/** One durable route choice. Transport and authentication are connection-only. */
export type LlmModelSelection<TOptions extends LlmJsonObject = LlmJsonObject> =
  Readonly<{ connection: string; model: string; options?: TOptions }>;

export type LlmModelSelections<TOptions extends LlmJsonObject = LlmJsonObject> =
  readonly [LlmModelSelection<TOptions>, ...LlmModelSelection<TOptions>[]];

/** Resolved built-in request configuration; internal to transport materialization. */
export type LlmBuiltinProviderConfiguration = Readonly<{
  provider: LlmBuiltinProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Readonly<Record<string, string>>;
  options?: LlmJsonObject;
  runtimeDiagnostics?: LlmRuntimeDiagnostics;
  executionIdentity?: LlmRuntimeExecutionIdentity;
}>;

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

/**
 * Provider-native reasoning state returned by an Adapter.  The block bodies
 * are deliberately opaque to Copilotz; only the producing transport identity
 * is interpreted when the state is replayed.
 */
export type LlmNativeReasoningInput = Readonly<{
  /** Provider wire format, for example `openai.responses` or `gemini.generateContent`. */
  api: string;
  /** Opaque provider blocks, represented as JSON content for durable storage. */
  blocks: ContentInput | readonly ContentInput[];
}>;

/** Durable native reasoning state after JSON content has been assetized. */
export type LlmNativeReasoning = Readonly<{
  schema: "copilotz.llm-native-reasoning.v1";
  adapter: string;
  api: string;
  model: string;
  blocks: ContentSequence;
}>;

/** Resolved native state passed to an LLM Adapter. */
export type LlmAdapterNativeReasoning = Readonly<{
  schema: "copilotz.llm-native-reasoning.v1";
  adapter: string;
  api: string;
  model: string;
  blocks: readonly LlmJsonObject[];
}>;

type LlmMessageBase = Readonly<{
  content: readonly (ContentSequence[number] | ActionContentEntry)[];
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
      reasoning?: readonly (ContentSequence[number] | ActionContentEntry)[];
      nativeReasoning?: LlmNativeReasoning;
      toolCalls?: readonly LlmToolCall[];
      /** Server-derived identity of the durable Tool plan that owns these calls. */
      toolPlanId?: string;
    }>
  )
  | (
    & LlmMessageBase
    & Readonly<{
      role: "tool";
      toolCallId: string;
      /** Server-derived identity of the durable Tool plan that owns this result. */
      toolPlanId?: string;
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
  models: LlmModelSelections;
  mode: LlmMode;
  request: LlmRequest;
  stream?: LlmStreamDescriptor;
  inputStreamId?: string;
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
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  cost?: LlmCost;
}>;

export type LlmAttemptStatus = "completed" | "failed" | "cancelled";

export type LlmAttemptUsage = Readonly<{
  id: string;
  index: number;
  /** True only when the Adapter reported a provider request actually began. */
  providerRequest: boolean;
  /** Connection alias selected for this provider attempt. */
  connection: string;
  /** Built-in provider name when the selected connection has one. */
  provider?: string;
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
  connection: string;
  model: string;
  /** Built-in provider name or selected custom LLM Adapter alias. */
  adapter: string;
  providerModel: string;
  content: ContentSequence;
  reasoning?: ContentSequence;
  nativeReasoning?: LlmNativeReasoning;
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
      reasoning?: string;
      nativeReasoning?: LlmAdapterNativeReasoning;
      toolCalls?: readonly LlmToolCall[];
      toolPlanId?: string;
    }>
  )
  | (
    & LlmAdapterMessageBase
    & Readonly<{
      role: "tool";
      toolCallId: string;
      toolPlanId?: string;
    }>
  );

/** Fully resolved request passed to an LLM Adapter. */
export type LlmAdapterRequest = Readonly<{
  messages: readonly LlmAdapterMessage[];
  tools?: readonly LlmToolDefinition[];
  instructions?: string;
}>;

export type LlmAdapterCallInput = Readonly<{
  /** Selected provider model identifier. */
  model: string;
  /** Built-in provider name or selected custom LLM Adapter alias. */
  adapter: string;
  /** Provider-specific model identifier from the selected candidate. */
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

/**
 * Bounded, credential-safe evidence for a provider attempt rejected before
 * `llm.call` can accept it. It is emitted only through Action progress, never
 * copied into another Model request or Tool input.
 */
export type LlmRejectedAttemptEvidence = Readonly<{
  code: string;
  message: string;
  location?: string;
  retryable: boolean;
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
  readonly rejectedAttemptEvidence?: LlmRejectedAttemptEvidence;

  constructor(
    message: string,
    options: Readonly<{
      attempts?: readonly LlmAdapterAttempt[];
      rejectedAttemptEvidence?: LlmRejectedAttemptEvidence;
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
    this.attempts = [...(options.attempts ?? [])] as const;
    this.rejectedAttemptEvidence = options.rejectedAttemptEvidence
      ? ({ ...options.rejectedAttemptEvidence } as const)
      : undefined;
  }
}

/** Runtime-only normalized result which `llm.call` materializes before return. */
export type LlmAdapterResult = Readonly<{
  content: ContentInput | readonly ContentInput[];
  reasoning?: ContentInput | readonly ContentInput[];
  /** Provider-native opaque blocks; the Action stamps adapter/model provenance. */
  nativeReasoning?: LlmNativeReasoningInput;
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
 * are configured directly by {@link LlmBuiltinProviderConfiguration} values instead.
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
  return ({ call: descriptor.value } as const) as TAdapter;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
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
      return (Array.from({ length: value.length }, (_, index) => {
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
    return (Object.fromEntries(entries));
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
  return (Object.fromEntries(
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

/** Validates and freezes one process-local connection Resource. */
export function normalizeLlmConnection(
  resource: LlmConnectionResource,
): LlmConnectionResource {
  const record = Object.fromEntries(
    plainDataEntries(resource, "LLM connection resource"),
  ) as Readonly<Record<string, unknown>>;
  if (record.adapter !== undefined) {
    const extra = Object.keys(record).find((key) => key !== "adapter");
    if (extra) throw new TypeError(`Unknown LLM connection field '${extra}'.`);
    const adapter = requiredText(record.adapter, "adapter");
    return ({ adapter } as const);
  }
  const extra = Object.keys(record).find((key) =>
    !new Set(["provider", "baseUrl", "auth", "runtimeDiagnostics"]).has(key)
  );
  if (extra) throw new TypeError(`Unknown LLM connection field '${extra}'.`);
  const provider = builtinProvider(record.provider, "LLM connection provider");
  const baseUrl = optionalText(record.baseUrl, "LLM connection baseUrl");
  const auth = Object.fromEntries(
    plainDataEntries(record.auth, "LLM connection auth"),
  );
  const dynamic = auth.resolve !== undefined;
  const authExtra = Object.keys(auth).find((key) =>
    !new Set(dynamic ? ["resolve"] : ["apiKey", "extraHeaders"]).has(key)
  );
  if (authExtra) {
    throw new TypeError(`Unknown LLM connection auth field '${authExtra}'.`);
  }
  if (dynamic && typeof auth.resolve !== "function") {
    throw new TypeError("LLM connection auth.resolve must be a function.");
  }
  const apiKey = dynamic
    ? undefined
    : optionalText(auth.apiKey, "LLM connection auth.apiKey");
  const extraHeaders = dynamic
    ? undefined
    : headerRecord(auth.extraHeaders, "LLM connection auth.extraHeaders");
  if (!dynamic && apiKey === undefined && extraHeaders === undefined) {
    throw new TypeError(
      "LLM connection auth requires apiKey, extraHeaders, or resolve.",
    );
  }

  let runtimeDiagnostics: LlmRuntimeDiagnostics | undefined;
  if (record.runtimeDiagnostics !== undefined) {
    const diagnostics = Object.fromEntries(plainDataEntries(
      record.runtimeDiagnostics,
      "LLM connection runtimeDiagnostics",
    ));
    const diagnosticExtra = Object.keys(diagnostics).find((key) =>
      key !== "enabled" && key !== "credentialSource"
    );
    if (diagnosticExtra) {
      throw new TypeError(
        `Unknown LLM connection runtimeDiagnostics field '${diagnosticExtra}'.`,
      );
    }
    if (
      diagnostics.enabled !== undefined &&
      typeof diagnostics.enabled !== "boolean"
    ) {
      throw new TypeError(
        "LLM connection runtimeDiagnostics.enabled must be boolean.",
      );
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
        "LLM connection runtimeDiagnostics.credentialSource is invalid.",
      );
    }
    runtimeDiagnostics = {
      ...(diagnostics.enabled === undefined
        ? {}
        : { enabled: diagnostics.enabled as boolean }),
      ...(diagnostics.credentialSource === undefined ? {} : {
        credentialSource: diagnostics.credentialSource as LlmCredentialSource,
      }),
    } as const;
  }

  return ({
    provider,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    auth: dynamic ? ({ resolve: auth.resolve as LlmAuthResolver } as const) : ({
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(extraHeaders === undefined ? {} : { extraHeaders }),
    } as const),
    ...(runtimeDiagnostics === undefined ? {} : { runtimeDiagnostics }),
  } as const) as LlmConnectionResource;
}

/** Validates one durable connection/model selection and freezes its JSON options. */
export function normalizeLlmModelSelection<
  TOptions extends LlmJsonObject = LlmJsonObject,
>(
  value: unknown,
  path = "LLM model selection",
): LlmModelSelection<TOptions> {
  const record = Object.fromEntries(plainDataEntries(value, path));
  const extra = Object.keys(record).find((key) =>
    !new Set(["connection", "model", "options"]).has(key)
  );
  if (extra) throw new TypeError(`${path}.${extra} is not supported.`);
  const connection = requiredText(record.connection, `${path}.connection`);
  const model = requiredText(record.model, `${path}.model`);
  const options = record.options === undefined
    ? undefined
    : canonicalJson(record.options, `${path}.options`);
  if (
    options !== undefined &&
    (options === null || Array.isArray(options) || typeof options !== "object")
  ) throw new TypeError(`${path}.options must be a JSON object.`);
  if (options) {
    const reserved = Object.keys(options).find((key) =>
      new Set([
        "provider",
        "adapter",
        "baseUrl",
        "apiKey",
        "extraHeaders",
        "auth",
        "connection",
        "model",
      ]).has(key)
    );
    if (reserved) {
      throw new TypeError(
        `${path}.options.${reserved} cannot override connection transport or authentication.`,
      );
    }
  }
  return ({
    connection,
    model,
    ...(options ? { options: options as TOptions } : {}),
  } as const);
}

export function normalizeLlmModelSelections(
  value: unknown,
  path = "LLM models",
): LlmModelSelections {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty array.`);
  }
  const selections = value.map((item, index) =>
    normalizeLlmModelSelection(item, `${path}[${index}]`)
  );
  const identities = selections.map((item) =>
    JSON.stringify([item.connection, item.model, item.options ?? null])
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${path} must not contain duplicate selections.`);
  }
  return [selections[0]!, ...selections.slice(1)];
}
