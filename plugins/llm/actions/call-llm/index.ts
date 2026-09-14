/** Provider-neutral durable LLM Action. @module */

import {
  type PreparedEntry,
  projectPreparedRequest,
} from "../../internal/prepared-request.ts";
import { preflightLlmRequest } from "../../adapters/bridge/index.ts";

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  AssetOrigin,
  ContentInput,
  ContentRef,
  ContentSequence,
  PreparedContent,
} from "@copilotz/copilotz/content";
import { adoptPreparedBody } from "@copilotz/copilotz/content";
import {
  type LlmAdapter,
  type LlmAdapterAttempt,
  LlmAdapterCallError,
  type LlmAdapterFrame,
  type LlmAdapterResult,
  type LlmAttemptUsage,
  type LlmAuthResolution,
  type LlmCallInput,
  type LlmCallOutput,
  type LlmConnectionContext,
  type LlmConnectionResource,
  type LlmJsonObject,
  type LlmJsonValue,
  type LlmMessage,
  type LlmModelSelection,
  type LlmNativeReasoning,
  type LlmNativeReasoningInput,
  type LlmRejectedAttemptEvidence,
  type LlmToolCall,
  type LlmToolPipeline,
  type LlmToolPipelineStage,
  type LlmUsage,
  normalizeLlmConnection,
  normalizeLlmModelSelections,
} from "../../internal/contracts.ts";
import { materializeBuiltinModel } from "../../adapters/index.ts";
import { createLlmAdapter } from "../../authoring/custom-adapter/index.ts";
import { deriveChatGptCodexCacheKey } from "../../internal/internal-cache-key.ts";

export const LLM_CALL_ACTION_ID = "llm.call";
export const LLM_CALL_ACTION_ALIAS = "callLlm";

/** Durable plan limits keep one provider response bounded and replayable. */
const MAX_TOOL_CALL_BRANCHES = 64;
const MAX_TOOL_PIPELINE_STAGES = 32;
const MAX_TOOL_PIPELINE_JQ_FILTER_LENGTH = 16_384;
const LLM_ATTEMPT_ACCOUNTING_SCHEMA = "copilotz.llm.attempt-accounting.v1";
const LLM_REJECTED_ATTEMPT_EVIDENCE_SCHEMA =
  "copilotz.llm.rejected-attempt-evidence";
const LLM_STREAM_BATCH_MAX_BYTES = 16 * 1_024;
const LLM_STREAM_BATCH_MAX_DELAY_MS = 50;
const llmCallInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["models", "mode", "request"],
  properties: {
    models: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["connection", "model"],
        properties: {
          connection: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          options: { $ref: "#/$defs/options" },
        },
      },
    },
    mode: { enum: ["generate", "session"] },
    request: { type: "object" },
    stream: { type: "object" },
    inputStreamId: { type: "string" },
  },
  $defs: {
    options: {
      type: "object",
      propertyNames: {
        not: {
          enum: [
            "provider",
            "adapter",
            "baseUrl",
            "apiKey",
            "extraHeaders",
            "auth",
            "connection",
            "model",
          ],
        },
      },
    },
  },
} as const;

export type LlmActionResources = Readonly<{
  llmConnections: Readonly<Record<string, LlmConnectionResource | undefined>>;
}>;

export type LlmActionAdapters = Readonly<{
  llm?: Readonly<Record<string, LlmAdapter | undefined>>;
}>;

/** Composed context expected by the provider-neutral LLM Action. */
export interface LlmActionContext
  extends ActionContext<LlmActionResources, LlmActionAdapters> {}

type ResolvedModel = Readonly<{
  alias: string;
  selection: LlmModelSelection;
  connection: LlmConnectionResource;
  adapterAlias: string;
  adapter?: LlmAdapter;
}>;

type ConnectionAttemptModel =
  | Readonly<{ kind: "ready"; candidate: ResolvedModel }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

type OpenWriter = Awaited<ReturnType<LlmActionContext["streams"]["open"]>>;

type StreamState = {
  writers: Map<string, Promise<OpenWriter>>;
  /** True only after non-speculative output can have reached a user. */
  visible: boolean;
  discard: boolean;
};

type SettledStream = Readonly<{
  key: string;
  lane: string;
  mediaType: string;
  writer: OpenWriter;
  prepared: PreparedContent;
}>;

type StreamFrameBatch = {
  writer: OpenWriter;
  chunks: Uint8Array[];
  byteLength: number;
  firstFrameIndex: number;
  lastFrameIndex: number;
  openedAt: number;
};

type ManagedInput = Readonly<{
  stream: ReadableStream<Uint8Array>;
  dispose(reason?: unknown): Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol properties.`);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data field.`);
    }
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new TypeError(`${path}.${unexpected} is not supported.`);
  }
}

function canonicalJson(
  value: unknown,
  path: string,
  active = new WeakSet<object>(),
): unknown {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON-safe values.`);
  }
  if (active.has(value)) {
    throw new TypeError(`${path} must not contain cycles.`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Object.keys(value).some((key, index) => key !== String(index))
      ) throw new TypeError(`${path} must be a dense JSON array.`);
      return Object.freeze(
        value.map((child, index) =>
          canonicalJson(child, `${path}[${index}]`, active)
        ),
      );
    }
    const record = plainRecord(value, path);
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(record).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data field.`);
      }
      result[key] = canonicalJson(descriptor.value, `${path}.${key}`, active);
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function jsonObject(value: unknown, path: string): LlmJsonObject {
  const result = canonicalJson(value, path);
  if (!isRecord(result)) throw new TypeError(`${path} must be a JSON object.`);
  return result as LlmJsonObject;
}

function sameCanonicalJson(left: LlmJsonValue, right: LlmJsonValue): boolean {
  if (left === right) return true;
  if (
    left === null || right === null || typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameCanonicalJson(value, right[index]!));
  }
  const leftObject = left as LlmJsonObject;
  const rightObject = right as LlmJsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      sameCanonicalJson(leftObject[key]!, rightObject[key]!)
    );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation was aborted.", "AbortError");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function managedInput(body: ReadableStream<Uint8Array>): ManagedInput {
  const reader = body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let disposed = false;
  const dispose = async (reason?: unknown): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      controller?.error(reason);
    } catch {
      // A normally closed or cancelled proxy is already detached.
    }
    await reader.cancel(reason).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A pending pull releases after cancellation settles.
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      if (disposed) return;
      try {
        const next = await reader.read();
        if (disposed) return;
        if (next.done) {
          disposed = true;
          reader.releaseLock();
          value.close();
          return;
        }
        value.enqueue(next.value.slice());
      } catch (error) {
        if (disposed) return;
        disposed = true;
        try {
          reader.releaseLock();
        } catch {
          // The reader may still be unwinding the failed pull.
        }
        value.error(error);
      }
    },
    cancel: dispose,
  });
  return Object.freeze({ stream, dispose });
}

function adapterFor(
  alias: string,
  adapters: LlmActionAdapters["llm"] | undefined,
): LlmAdapter {
  const adapter = adapters?.[alias];
  if (!adapter) throw new Error(`Unknown LLM adapter '${alias}'.`);
  return createLlmAdapter(adapter);
}

/**
 * Validates every ordered selection and connection before provider I/O.
 */
function modelPlan(
  requested: LlmCallInput["models"],
  mode: LlmCallInput["mode"],
  context: LlmActionContext,
): readonly ResolvedModel[] {
  const connections = context.resources.llmConnections;
  const adapters = context.adapters.llm;
  if (!isRecord(connections)) {
    throw new TypeError("LLM resources.llmConnections must be an alias map.");
  }
  const plan = requested.map((selection) => {
    const connection = connections[selection.connection];
    if (!connection) {
      throw new Error(`Unknown LLM connection '${selection.connection}'.`);
    }
    const resource = normalizeLlmConnection(connection);
    if (resource.provider !== undefined) {
      const auth = resource.auth;
      // Validate modes/options for every candidate without resolving dynamic auth.
      materializeBuiltinModel(
        {
          provider: resource.provider,
          model: selection.model,
          baseUrl: resource.baseUrl,
          ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
          ...(auth.extraHeaders === undefined
            ? {}
            : { extraHeaders: auth.extraHeaders }),
        },
        mode,
        selection.options ?? Object.freeze({}),
      );
      return Object.freeze({
        alias: selection.connection,
        selection,
        connection: resource,
        adapterAlias: resource.provider,
      });
    }
    return Object.freeze({
      alias: selection.connection,
      selection,
      connection: resource,
      adapterAlias: resource.adapter,
      adapter: adapterFor(resource.adapter, adapters),
    });
  });
  return Object.freeze(plan);
}
function connectionContext(context: LlmActionContext): LlmConnectionContext {
  return Object.freeze({
    namespace: context.namespace,
    operationKey: context.operationKey,
    identity: context.identity,
    action: context.action,
    collections: context.collections,
    signal: context.signal,
    now: context.now,
  });
}

function resolvedAuth(value: unknown): LlmAuthResolution {
  const record = plainRecord(value, "LLM credential resolution");
  exactKeys(
    record,
    new Set(["available", "apiKey", "extraHeaders", "reason"]),
    "LLM credential resolution",
  );
  if (record.available === true) {
    if (record.reason !== undefined) {
      throw new TypeError(
        "An available LLM credential resolution cannot include reason.",
      );
    }
    const apiKey = record.apiKey === undefined
      ? undefined
      : requiredText(record.apiKey, "LLM credential resolution.apiKey");
    const extraHeaders = record.extraHeaders === undefined
      ? undefined
      : stringHeaders(
        record.extraHeaders,
        "LLM credential resolution.extraHeaders",
      );
    if (apiKey === undefined && extraHeaders === undefined) {
      throw new TypeError(
        "An available LLM credential resolution requires apiKey or extraHeaders.",
      );
    }
    return apiKey !== undefined
      ? Object.freeze({
        available: true,
        apiKey,
        ...(extraHeaders === undefined ? {} : { extraHeaders }),
      })
      : Object.freeze({ available: true, extraHeaders: extraHeaders! });
  }
  if (
    record.available !== false || record.apiKey !== undefined ||
    record.extraHeaders !== undefined
  ) {
    throw new TypeError(
      "An unavailable LLM credential resolution may only include reason.",
    );
  }
  return Object.freeze({
    available: false,
    ...(record.reason === undefined ? {} : {
      reason: requiredText(record.reason, "LLM credential resolution.reason"),
    }),
  });
}

function stringHeaders(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> {
  const record = plainRecord(value, path);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, entry]) => {
        if (!key.trim() || typeof entry !== "string") {
          throw new TypeError(
            `${path} requires non-empty names and string values.`,
          );
        }
        return [key, entry];
      }),
    ),
  );
}

type TrustedApplicationSessionMetadata = Readonly<{
  threadId: string;
  agentId: string;
}>;

/**
 * This closed metadata shape is accepted only from trusted application Action
 * metadata. It is never read from durable request options or message content.
 */
function trustedApplicationSessionMetadata(
  context: LlmActionContext,
): TrustedApplicationSessionMetadata | undefined {
  const metadata = context.action.metadata;
  const value = metadata.llmSession;
  if (!isRecord(value) || Object.keys(value).length !== 3) return undefined;
  if (value.schema !== "copilotz.llm-session.v1") return undefined;
  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const agentId = typeof value.agentId === "string" ? value.agentId : "";
  return threadId.trim() && agentId.trim()
    ? Object.freeze({ threadId, agentId })
    : undefined;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) =>
    key.toLowerCase() === name
  );
  const value = entry?.[1];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isChatGptCodexConnection(candidate: ResolvedModel): boolean {
  if (candidate.connection.provider !== "openai") return false;
  try {
    const url = new URL(candidate.connection.baseUrl ?? "");
    return url.protocol === "https:" && url.hostname === "chatgpt.com" &&
      (url.pathname.replace(/\/+$/, "") === "/backend-api/codex" ||
        url.pathname.startsWith("/backend-api/codex/"));
  } catch {
    return false;
  }
}

async function attemptModel(
  candidate: ResolvedModel,
  input: LlmCallInput,
  context: LlmActionContext,
  connectionMemo: Map<string, Promise<LlmAuthResolution | undefined>>,
): Promise<ConnectionAttemptModel> {
  if (candidate.connection.provider === undefined) {
    return Object.freeze({ kind: "ready", candidate });
  }
  const auth = candidate.connection.auth;
  let resolution: LlmAuthResolution | undefined;
  if (typeof auth.resolve === "function") {
    const alias = candidate.alias;
    let resolving = connectionMemo.get(alias);
    if (!resolving) {
      resolving = Promise.resolve().then(async () => {
        try {
          return resolvedAuth(
            await raceSignal(
              Promise.resolve(auth.resolve!(
                connectionContext(context),
                Object.freeze({ connection: alias }),
              )),
              context.signal,
            ),
          );
        } catch {
          // Resolver exceptions may contain OAuth material. Never expose them
          // through the Action lifecycle or allow them to skip sanitization.
          return undefined;
        }
      });
      connectionMemo.set(alias, resolving);
    }
    resolution = await resolving;
    if (resolution === undefined) return Object.freeze({ kind: "failed" });
    if (!resolution.available) return Object.freeze({ kind: "unavailable" });
  }
  const authFields = typeof auth.resolve === "function"
    ? (() => {
      const resolved = resolution!;
      if (!resolved.available) return undefined;
      return {
        ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
        ...(resolved.extraHeaders === undefined
          ? {}
          : { extraHeaders: resolved.extraHeaders }),
      };
    })()
    : {
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(auth.extraHeaders === undefined
        ? {}
        : { extraHeaders: auth.extraHeaders }),
    };
  if (!authFields) return Object.freeze({ kind: "unavailable" });
  const resource = {
    provider: candidate.connection.provider,
    model: candidate.selection.model,
    ...(candidate.connection.baseUrl
      ? { baseUrl: candidate.connection.baseUrl }
      : {}),
    ...(candidate.connection.runtimeDiagnostics
      ? { runtimeDiagnostics: candidate.connection.runtimeDiagnostics }
      : {}),
    ...authFields,
  };
  const session = trustedApplicationSessionMetadata(context);
  const accountId = headerValue(authFields.extraHeaders, "chatgpt-account-id");
  const executionIdentity =
    session && accountId && isChatGptCodexConnection(candidate)
      ? {
        cacheKey: await deriveChatGptCodexCacheKey(
          accountId,
          context.namespace,
          session.threadId,
          session.agentId,
        ),
      }
      : undefined;
  return Object.freeze({
    kind: "ready",
    candidate: Object.freeze({
      ...candidate,
      adapter: materializeBuiltinModel(
        { ...resource, ...(executionIdentity ? { executionIdentity } : {}) },
        input.mode,
        candidate.selection.options ?? Object.freeze({}),
      ),
    }),
  });
}

const CONTENT_REF_KEYS = new Set([
  "assetId",
  "kind",
  "role",
  "mediaType",
  "name",
  "alt",
  "language",
  "disposition",
  "metadata",
]);
const CONTENT_INPUT_KEYS = new Set([
  "type",
  "text",
  "value",
  "bytes",
  "role",
  "mediaType",
  "name",
  "alt",
  "language",
  "disposition",
  "metadata",
  "origin",
]);
const CONTENT_KINDS = new Set([
  "text",
  "json",
  "image",
  "audio",
  "video",
  "file",
]);

function optionalText(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path);
}

function contentCommon(
  record: Record<string, unknown>,
  path: string,
): Readonly<Record<string, unknown>> {
  const role = optionalText(record.role, `${path}.role`);
  const mediaType = optionalText(record.mediaType, `${path}.mediaType`);
  const name = optionalText(record.name, `${path}.name`);
  const alt = optionalText(record.alt, `${path}.alt`);
  const language = optionalText(record.language, `${path}.language`);
  const disposition = record.disposition;
  if (
    disposition !== undefined && disposition !== "inline" &&
    disposition !== "attachment"
  ) throw new TypeError(`${path}.disposition is invalid.`);
  const metadata = record.metadata === undefined
    ? undefined
    : jsonObject(record.metadata, `${path}.metadata`);
  let origin: AssetOrigin | undefined;
  if (record.origin !== undefined) {
    const value = plainRecord(record.origin, `${path}.origin`);
    exactKeys(
      value,
      new Set(["type", "id"]),
      `${path}.origin`,
    );
    origin = Object.freeze({
      type: requiredText(value.type, `${path}.origin.type`),
      id: requiredText(value.id, `${path}.origin.id`),
    });
  }
  return Object.freeze({
    ...(role ? { role } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(name ? { name } : {}),
    ...(alt ? { alt } : {}),
    ...(language ? { language } : {}),
    ...(disposition ? { disposition } : {}),
    ...(metadata ? { metadata } : {}),
    ...(origin ? { origin } : {}),
  });
}

function normalizedContentInput(value: unknown, path: string): ContentInput {
  if (typeof value === "string") return value;
  const record = plainRecord(value, path);
  if ("assetId" in record) {
    exactKeys(record, CONTENT_REF_KEYS, path);
    const kind = requiredText(record.kind, `${path}.kind`);
    if (!CONTENT_KINDS.has(kind)) {
      throw new TypeError(`${path}.kind is invalid.`);
    }
    const name = optionalText(record.name, `${path}.name`);
    const alt = optionalText(record.alt, `${path}.alt`);
    const language = optionalText(record.language, `${path}.language`);
    if (
      record.disposition !== undefined && record.disposition !== "inline" &&
      record.disposition !== "attachment"
    ) throw new TypeError(`${path}.disposition is invalid.`);
    const metadata = record.metadata === undefined
      ? undefined
      : jsonObject(record.metadata, `${path}.metadata`);
    return Object.freeze({
      assetId: requiredText(record.assetId, `${path}.assetId`),
      kind,
      role: requiredText(record.role, `${path}.role`),
      mediaType: requiredText(record.mediaType, `${path}.mediaType`),
      ...(name ? { name } : {}),
      ...(alt ? { alt } : {}),
      ...(language ? { language } : {}),
      ...(record.disposition ? { disposition: record.disposition } : {}),
      ...(metadata ? { metadata } : {}),
    }) as ContentRef;
  }
  exactKeys(record, CONTENT_INPUT_KEYS, path);
  const type = requiredText(record.type, `${path}.type`);
  if (!CONTENT_KINDS.has(type)) throw new TypeError(`${path}.type is invalid.`);
  const common = contentCommon(record, path);
  if (type === "text") {
    if (typeof record.text !== "string") {
      throw new TypeError(`${path}.text must be a string.`);
    }
    return Object.freeze({
      type,
      text: record.text,
      ...common,
    }) as ContentInput;
  }
  if (type === "json") {
    return Object.freeze({
      type,
      value: canonicalJson(record.value, `${path}.value`),
      ...common,
    }) as ContentInput;
  }
  if (!(record.bytes instanceof Uint8Array)) {
    throw new TypeError(`${path}.bytes must be Uint8Array.`);
  }
  return Object.freeze({
    type,
    bytes: record.bytes.slice(),
    mediaType: requiredText(record.mediaType, `${path}.mediaType`),
    ...common,
  }) as ContentInput;
}

function normalizedContent(
  value: unknown,
  path: string,
): readonly ContentInput[] {
  const values = Array.isArray(value) ? value : [value];
  return Object.freeze(
    values.map((item, index) =>
      normalizedContentInput(item, `${path}[${index}]`)
    ),
  );
}

class MalformedToolCallError extends Error {
  readonly evidence: LlmRejectedAttemptEvidence;

  constructor(location?: string) {
    super("LLM Adapter returned malformed tool calls.");
    this.name = "MalformedToolCallError";
    this.evidence = Object.freeze({
      code: "malformed_tool_call",
      message:
        "The model returned a tool call that does not match the declared tool contract.",
      ...(location ? { location } : {}),
      retryable: true,
    });
  }
}

function malformedToolCallError(error: unknown): MalformedToolCallError {
  if (error instanceof MalformedToolCallError) return error;
  const message = error instanceof Error ? error.message : "";
  const match =
    /LLM Adapter result\.(toolCalls(?:\[[0-9]+\])?(?:\.(?:id|action|input|pipeline))?)/
      .exec(message);
  return new MalformedToolCallError(match?.[1]);
}

function normalizedToolCalls(value: unknown): readonly LlmToolCall[] {
  try {
    if (!Array.isArray(value)) {
      throw new TypeError("LLM Adapter result.toolCalls must be an array.");
    }
    if (value.length > MAX_TOOL_CALL_BRANCHES) {
      throw new TypeError(
        `LLM Adapter result.toolCalls must contain at most ${MAX_TOOL_CALL_BRANCHES} parallel branches.`,
      );
    }
    const ids = new Set<string>();
    return Object.freeze(value.map((item, index) => {
      const path = `LLM Adapter result.toolCalls[${index}]`;
      const record = plainRecord(item, path);
      exactKeys(record, new Set(["id", "action", "input", "pipeline"]), path);
      const id = requiredText(record.id, `${path}.id`);
      if (ids.has(id)) {
        throw new TypeError(
          "LLM Adapter result.toolCalls contains duplicate ids.",
        );
      }
      ids.add(id);
      const action = requiredText(record.action, `${path}.action`);
      const input = jsonObject(record.input, `${path}.input`);
      const pipeline = record.pipeline === undefined
        ? undefined
        : normalizedToolPipeline(record.pipeline, path, id, action, input);
      return Object.freeze({
        id,
        action,
        input,
        ...(pipeline ? { pipeline } : {}),
      });
    }));
  } catch (error) {
    throw malformedToolCallError(error);
  }
}

function normalizedToolPipeline(
  value: unknown,
  path: string,
  rootId: string,
  rootAction: string,
  rootInput: LlmJsonObject,
): LlmToolPipeline {
  const record = plainRecord(value, `${path}.pipeline`);
  exactKeys(record, new Set(["id", "stages"]), `${path}.pipeline`);
  const id = requiredText(record.id, `${path}.pipeline.id`);
  if (!Array.isArray(record.stages) || record.stages.length === 0) {
    throw new TypeError(`${path}.pipeline.stages must be a non-empty array.`);
  }
  if (record.stages.length > MAX_TOOL_PIPELINE_STAGES) {
    throw new TypeError(
      `${path}.pipeline.stages must contain at most ${MAX_TOOL_PIPELINE_STAGES} stages.`,
    );
  }
  const stages = Object.freeze(
    record.stages.map((item, index): LlmToolPipelineStage => {
      const stagePath = `${path}.pipeline.stages[${index}]`;
      const stage = plainRecord(item, stagePath);
      const type = requiredText(stage.type, `${stagePath}.type`);
      if (type === "jq") {
        exactKeys(stage, new Set(["type", "filter"]), stagePath);
        const filter = requiredText(stage.filter, `${stagePath}.filter`);
        if (filter.length > MAX_TOOL_PIPELINE_JQ_FILTER_LENGTH) {
          throw new TypeError(
            `${stagePath}.filter must contain at most ${MAX_TOOL_PIPELINE_JQ_FILTER_LENGTH} characters.`,
          );
        }
        return Object.freeze({
          type: "jq" as const,
          filter,
        });
      }
      if (type !== "tool") {
        throw new TypeError(`${stagePath}.type must be 'tool' or 'jq'.`);
      }
      exactKeys(stage, new Set(["type", "id", "action", "input"]), stagePath);
      return Object.freeze({
        type: "tool" as const,
        id: requiredText(stage.id, `${stagePath}.id`),
        action: requiredText(stage.action, `${stagePath}.action`),
        input: jsonObject(stage.input, `${stagePath}.input`),
      });
    }),
  );
  const first = stages[0];
  if (first.type !== "tool") {
    throw new TypeError(`${path}.pipeline must begin with a tool stage.`);
  }
  if (
    first.id !== rootId || first.action !== rootAction ||
    !sameCanonicalJson(first.input, rootInput)
  ) {
    throw new TypeError(
      `${path}.pipeline first tool stage must match the root id, action, and input.`,
    );
  }
  return Object.freeze({
    id,
    stages: stages as unknown as readonly [
      typeof first,
      ...LlmToolPipelineStage[],
    ],
  });
}

function normalizedPreparedSequence(
  value: unknown,
  path: string,
): readonly PreparedEntry[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be a content sequence.`);
  }
  return Object.freeze(value.map((value, index) => {
    const item = plainRecord(value, `${path}[${index}]`);
    const { value: body, resolve, ...reference } = item;
    const ref = normalizedContentInput(reference, `${path}[${index}]`);
    if (typeof ref === "string" || !("assetId" in ref)) {
      throw new TypeError(`${path} requires prepared content entries.`);
    }
    if (resolve === false) {
      if (Object.hasOwn(item, "value")) {
        throw new TypeError("Descriptor content cannot contain a value.");
      }
      return { ...ref, resolve: false as const };
    }
    if (resolve !== undefined || !Object.hasOwn(item, "value")) {
      throw new TypeError(`${path} requires runtime-prepared values.`);
    }
    if (
      ref.kind === "text" && typeof body !== "string" ||
      ref.kind !== "text" && ref.kind !== "json" &&
        !(body instanceof Uint8Array)
    ) {
      throw new TypeError(`${path} has an invalid prepared value.`);
    }
    return {
      ...ref,
      value: ref.kind === "json"
        ? canonicalJson(body, `${path}[${index}].value`)
        : structuredClone(body),
    };
  }));
}

function normalizedNativeReasoning(
  value: unknown,
  path: string,
): LlmNativeReasoning {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    new Set([
      "schema",
      "adapter",
      "api",
      "model",
      "blocks",
    ]),
    path,
  );
  if (record.schema !== "copilotz.llm-native-reasoning.v1") {
    throw new TypeError(`${path}.schema is invalid.`);
  }
  const blocks = normalizedPreparedSequence(record.blocks, `${path}.blocks`);
  if (
    blocks.length === 0 ||
    blocks.some((block) =>
      block.kind !== "json" || block.resolve === false ||
      !Object.hasOwn(block, "value") || !block.value ||
      typeof block.value !== "object" || Array.isArray(block.value)
    )
  ) {
    throw new TypeError(`${path}.blocks must contain prepared JSON values.`);
  }
  return Object.freeze({
    schema: "copilotz.llm-native-reasoning.v1" as const,
    adapter: requiredText(record.adapter, `${path}.adapter`),
    api: requiredText(record.api, `${path}.api`),
    model: requiredText(record.model, `${path}.model`),
    blocks,
  });
}

function normalizedNativeReasoningResult(
  value: unknown,
  path: string,
): LlmNativeReasoningInput {
  const record = plainRecord(value, path);
  exactKeys(record, new Set(["api", "blocks"]), path);
  const allBlocks = normalizedContent(record.blocks, `${path}.blocks`);
  const blocks = allBlocks.filter(
    (block): block is Extract<ContentInput, { type: "json" }> =>
      typeof block !== "string" && "type" in block && block.type === "json",
  );
  if (blocks.length !== allBlocks.length || blocks.length === 0) {
    throw new TypeError(`${path}.blocks must contain JSON objects.`);
  }
  if (
    blocks.some((block) =>
      !block.value || typeof block.value !== "object" ||
      Array.isArray(block.value)
    )
  ) {
    throw new TypeError(`${path}.blocks must contain JSON objects.`);
  }
  return Object.freeze({
    api: requiredText(record.api, `${path}.api`),
    blocks,
  });
}

function normalizedMessage(value: unknown, index: number): LlmMessage {
  const path = `LLM request.messages[${index}]`;
  const record = plainRecord(value, path);
  const role = requiredText(record.role, `${path}.role`);
  const commonKeys = ["role", "content", "name", "metadata"];
  const allowed = role === "assistant"
    ? new Set([
      ...commonKeys,
      "toolCalls",
      "reasoning",
      "nativeReasoning",
      "toolPlanId",
    ])
    : role === "tool"
    ? new Set([...commonKeys, "toolCallId", "toolPlanId"])
    : new Set(commonKeys);
  exactKeys(record, allowed, path);
  if (!["system", "user", "assistant", "tool"].includes(role)) {
    throw new TypeError(`${path}.role is invalid.`);
  }
  if (!Array.isArray(record.content)) {
    throw new TypeError(`${path}.content must be a ContentSequence.`);
  }
  const content = normalizedPreparedSequence(record.content, `${path}.content`);
  const name = optionalText(record.name, `${path}.name`);
  const metadata = record.metadata === undefined
    ? undefined
    : jsonObject(record.metadata, `${path}.metadata`);
  const common = {
    content,
    ...(name ? { name } : {}),
    ...(metadata ? { metadata } : {}),
  };
  if (role === "assistant") {
    const toolCalls = record.toolCalls === undefined
      ? undefined
      : normalizedToolCalls(record.toolCalls);
    return Object.freeze({
      role,
      ...common,
      ...(toolCalls ? { toolCalls } : {}),
      ...(record.toolPlanId === undefined ? {} : {
        toolPlanId: requiredText(record.toolPlanId, `${path}.toolPlanId`),
      }),
      ...(record.reasoning !== undefined
        ? {
          reasoning: normalizedPreparedSequence(
            record.reasoning,
            `${path}.reasoning`,
          ),
        }
        : {}),
      ...(record.nativeReasoning !== undefined
        ? {
          nativeReasoning: normalizedNativeReasoning(
            record.nativeReasoning,
            `${path}.nativeReasoning`,
          ),
        }
        : {}),
    });
  }
  if (role === "tool") {
    return Object.freeze({
      role,
      ...common,
      toolCallId: requiredText(record.toolCallId, `${path}.toolCallId`),
      ...(record.toolPlanId === undefined ? {} : {
        toolPlanId: requiredText(record.toolPlanId, `${path}.toolPlanId`),
      }),
    });
  }
  return Object.freeze({ role, ...common }) as LlmMessage;
}

function normalizedRequest(value: unknown): LlmCallInput["request"] {
  const path = "LLM request";
  const record = plainRecord(value, path);
  exactKeys(record, new Set(["messages", "tools", "instructions"]), path);
  if (!Array.isArray(record.messages)) {
    throw new TypeError("LLM request.messages must be an array.");
  }
  const messages = Object.freeze(
    record.messages.map((message, index) => normalizedMessage(message, index)),
  );
  let tools: LlmCallInput["request"]["tools"];
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) {
      throw new TypeError("LLM request.tools must be an array.");
    }
    tools = Object.freeze(record.tools.map((tool, index) => {
      const toolPath = `LLM request.tools[${index}]`;
      const item = plainRecord(tool, toolPath);
      exactKeys(
        item,
        new Set(["name", "description", "inputSchema"]),
        toolPath,
      );
      return Object.freeze({
        name: requiredText(item.name, `${toolPath}.name`),
        description: requiredText(item.description, `${toolPath}.description`),
        ...(item.inputSchema !== undefined
          ? {
            inputSchema: jsonObject(
              item.inputSchema,
              `${toolPath}.inputSchema`,
            ),
          }
          : {}),
      });
    }));
  }
  if (
    record.instructions !== undefined &&
    typeof record.instructions !== "string"
  ) throw new TypeError("LLM request.instructions must be a string.");
  return Object.freeze({
    messages,
    ...(tools ? { tools } : {}),
    ...(record.instructions !== undefined
      ? { instructions: record.instructions }
      : {}),
  });
}

function normalizedCallInput(value: unknown): LlmCallInput {
  const record = plainRecord(value, "LLM call input");
  exactKeys(
    record,
    new Set([
      "models",
      "mode",
      "request",
      "stream",
      "inputStreamId",
    ]),
    "LLM call input",
  );
  const models = normalizeLlmModelSelections(
    record.models,
    "LLM call input.models",
  );
  if (record.mode !== "generate" && record.mode !== "session") {
    throw new TypeError("LLM call input.mode must be 'generate' or 'session'.");
  }
  const mode = record.mode;
  const request = normalizedRequest(record.request);
  let stream: LlmCallInput["stream"];
  if (record.stream !== undefined) {
    const item = plainRecord(record.stream, "LLM stream descriptor");
    exactKeys(item, new Set(["id", "metadata"]), "LLM stream descriptor");
    const id = optionalText(item.id, "LLM stream descriptor.id");
    const metadata = item.metadata === undefined
      ? undefined
      : jsonObject(item.metadata, "LLM stream descriptor.metadata");
    stream = Object.freeze({
      ...(id ? { id } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  const inputStreamId = optionalText(
    record.inputStreamId,
    "LLM input stream ID",
  );
  return Object.freeze({
    models,
    mode,
    request,
    ...(stream ? { stream } : {}),
    ...(inputStreamId ? { inputStreamId } : {}),
  });
}

function normalizedUsage(value: unknown, path: string): LlmUsage {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    new Set([
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cachedInputTokens",
      "cacheCreationInputTokens",
      "totalTokens",
      "cost",
    ]),
    path,
  );
  const token = (key: string): number | undefined => {
    const item = record[key];
    if (item === undefined) return undefined;
    if (!Number.isSafeInteger(item) || (item as number) < 0) {
      throw new TypeError(`${path}.${key} must be a non-negative integer.`);
    }
    return item as number;
  };
  let cost: LlmUsage["cost"];
  if (record.cost !== undefined) {
    const item = plainRecord(record.cost, `${path}.cost`);
    exactKeys(item, new Set(["amount", "currency"]), `${path}.cost`);
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) {
      throw new TypeError(`${path}.cost.amount must be finite.`);
    }
    cost = Object.freeze({
      amount: item.amount,
      currency: requiredText(item.currency, `${path}.cost.currency`),
    });
  }
  return Object.freeze({
    ...(token("inputTokens") !== undefined
      ? { inputTokens: token("inputTokens") }
      : {}),
    ...(token("outputTokens") !== undefined
      ? { outputTokens: token("outputTokens") }
      : {}),
    ...(token("reasoningTokens") !== undefined
      ? { reasoningTokens: token("reasoningTokens") }
      : {}),
    ...(token("cachedInputTokens") !== undefined
      ? { cachedInputTokens: token("cachedInputTokens") }
      : {}),
    ...(token("cacheCreationInputTokens") !== undefined
      ? { cacheCreationInputTokens: token("cacheCreationInputTokens") }
      : {}),
    ...(token("totalTokens") !== undefined
      ? { totalTokens: token("totalTokens") }
      : {}),
    ...(cost ? { cost } : {}),
  });
}

function normalizedAdapterAttempt(
  value: unknown,
  path: string,
): LlmAdapterAttempt {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    new Set([
      "status",
      "usage",
      "finishReason",
      "error",
      "startedAt",
      "finishedAt",
    ]),
    path,
  );
  if (!["completed", "failed", "cancelled"].includes(String(record.status))) {
    throw new TypeError(`${path}.status is invalid.`);
  }
  let error: LlmAdapterAttempt["error"];
  if (record.error !== undefined) {
    const item = plainRecord(record.error, `${path}.error`);
    exactKeys(item, new Set(["code", "message"]), `${path}.error`);
    error = Object.freeze({
      ...(optionalText(item.code, `${path}.error.code`)
        ? { code: optionalText(item.code, `${path}.error.code`) }
        : {}),
      message: requiredText(item.message, `${path}.error.message`),
    });
  }
  return Object.freeze({
    status: record.status as LlmAdapterAttempt["status"],
    ...(record.usage
      ? { usage: normalizedUsage(record.usage, `${path}.usage`) }
      : {}),
    ...(optionalText(record.finishReason, `${path}.finishReason`)
      ? {
        finishReason: optionalText(record.finishReason, `${path}.finishReason`),
      }
      : {}),
    ...(error ? { error } : {}),
    ...(optionalText(record.startedAt, `${path}.startedAt`)
      ? { startedAt: optionalText(record.startedAt, `${path}.startedAt`) }
      : {}),
    ...(optionalText(record.finishedAt, `${path}.finishedAt`)
      ? { finishedAt: optionalText(record.finishedAt, `${path}.finishedAt`) }
      : {}),
  });
}

function streamKey(frame: LlmAdapterFrame): string {
  return JSON.stringify([frame.lane, frame.mediaType]);
}

function isSpeculativeToolDraftLane(lane: string): boolean {
  return lane === "tool-calls" || lane === "tool-call-drafts";
}

function streamSegment(value: string): string {
  return encodeURIComponent(value);
}

async function writerFor(
  frame: LlmAdapterFrame,
  attempt: ResolvedModel,
  attemptIndex: number,
  input: LlmCallInput,
  context: LlmActionContext,
  state: StreamState,
  signal: AbortSignal,
): Promise<OpenWriter | undefined> {
  if (!input.stream) return undefined;
  const lane = requiredText(frame.lane, "LLM frame lane");
  const mediaType = requiredText(frame.mediaType, "LLM frame media type");
  const key = streamKey({ ...frame, lane, mediaType });
  let opening = state.writers.get(key);
  if (!opening) {
    // `streams.open` itself may establish the durable publication boundary
    // before its Promise rejects (for example, if a later live observer fails).
    // Answer/media publication commits this candidate. Reasoning and tool
    // drafts may be replaced by a later candidate without executing a Tool.
    if (lane !== "reasoning" && !isSpeculativeToolDraftLane(lane)) {
      state.visible = true;
    }
    const base = input.stream.id?.trim() || context.action.runId;
    // Provider attempts are distinct physical evidence lanes. Reusing the
    // previous semantic id would either splice retry bytes or conflict with
    // the retained immutable prefix after a rejected attempt terminates.
    const id = `${base}:provider-attempt:${attemptIndex}:${
      streamSegment(lane)
    }:${streamSegment(mediaType)}`;
    opening = context.streams.open({
      id,
      role: lane,
      mediaType,
      metadata: {
        ...(input.stream.metadata ?? {}),
        llmAttemptId: context.action.runId,
        providerAttemptIndex: attemptIndex,
        lane,
        connection: attempt.alias,
        model: attempt.selection.model,
        adapter: attempt.adapterAlias,
      },
      ...(context.identity.correlationId
        ? { correlationId: context.identity.correlationId }
        : {}),
    }, { signal });
    state.writers.set(key, opening);
  }
  const writer = await opening;
  // Tool-call deltas are speculative protocol drafts. Core receives executable
  // Tool calls only from a validated `llm.call.completed` result, so a malformed
  // draft must not block an external Model fallback.
  return writer;
}

async function pumpFrames(
  reader: ReadableStreamDefaultReader<LlmAdapterFrame>,
  attempt: ResolvedModel,
  attemptIndex: number,
  input: LlmCallInput,
  context: LlmActionContext,
  state: StreamState,
  signal: AbortSignal,
): Promise<void> {
  let frameIndex = 0;
  let pendingRead:
    | Promise<ReadableStreamReadResult<LlmAdapterFrame>>
    | undefined;
  const batches = new Map<string, StreamFrameBatch>();

  const read = () => {
    if (pendingRead) return pendingRead;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Operation was aborted.", "AbortError"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    pendingRead = Promise.race([reader.read(), aborted]).finally(
      removeAbortListener,
    );
    return pendingRead;
  };

  const flush = async (key: string): Promise<void> => {
    const batch = batches.get(key);
    if (!batch) return;
    batches.delete(key);
    const bytes = new Uint8Array(batch.byteLength);
    let offset = 0;
    for (const chunk of batch.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      await batch.writer.append({
        bytes,
        appendId:
          `${context.action.runId}:attempt:${attemptIndex}:frames:${batch.firstFrameIndex}-${batch.lastFrameIndex}`,
      }, { signal });
    } catch (error) {
      throw new FrameworkInvocationError(
        "LLM Adapter frame failed Copilotz validation or publication.",
        error,
      );
    }
  };

  const flushAll = async (): Promise<void> => {
    for (const key of [...batches.keys()]) await flush(key);
  };

  const waitForReadOrFlush = async (): Promise<
    | Readonly<{
      kind: "read";
      value: ReadableStreamReadResult<LlmAdapterFrame>;
    }>
    | Readonly<{ kind: "flush" }>
  > => {
    const earliest = Math.min(
      ...[...batches.values()].map((batch) =>
        batch.openedAt + LLM_STREAM_BATCH_MAX_DELAY_MS
      ),
    );
    let timer: number | undefined;
    const due = new Promise<Readonly<{ kind: "flush" }>>((resolve) => {
      timer = setTimeout(
        () => resolve(Object.freeze({ kind: "flush" as const })),
        Math.max(0, earliest - Date.now()),
      ) as unknown as number;
    });
    try {
      return await Promise.race([
        read().then((value) => Object.freeze({ kind: "read" as const, value })),
        due,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  while (true) {
    throwIfAborted(signal);
    const outcome = batches.size > 0
      ? await waitForReadOrFlush()
      : Object.freeze({ kind: "read" as const, value: await read() });
    if (outcome.kind === "flush") {
      await flushAll();
      continue;
    }
    pendingRead = undefined;
    const next = outcome.value;
    if (next.done) {
      await flushAll();
      return;
    }
    try {
      const raw = plainRecord(next.value, "LLM Adapter frame");
      if (!(raw.bytes instanceof Uint8Array)) {
        throw new TypeError("LLM Adapter emitted an invalid frame.");
      }
      exactKeys(
        raw,
        new Set(["lane", "mediaType", "bytes"]),
        "LLM Adapter frame",
      );
      const frame = Object.freeze({
        lane: requiredText(raw.lane, "LLM frame lane"),
        mediaType: requiredText(raw.mediaType, "LLM frame media type"),
        bytes: raw.bytes.slice(),
      });
      if (frame.bytes.byteLength === 0 || state.discard) continue;
      const writer = await writerFor(
        frame,
        attempt,
        attemptIndex,
        input,
        context,
        state,
        signal,
      );
      if (writer) {
        const key = streamKey(frame);
        const batch = batches.get(key) ?? {
          writer,
          chunks: [],
          byteLength: 0,
          firstFrameIndex: frameIndex,
          lastFrameIndex: frameIndex,
          openedAt: Date.now(),
        };
        batch.chunks.push(frame.bytes);
        batch.byteLength += frame.bytes.byteLength;
        batch.lastFrameIndex = frameIndex;
        batches.set(key, batch);
        if (batch.byteLength >= LLM_STREAM_BATCH_MAX_BYTES) {
          await flush(key);
        }
      }
      frameIndex += 1;
    } catch (error) {
      throw new FrameworkInvocationError(
        "LLM Adapter frame failed Copilotz validation or publication.",
        error,
      );
    }
  }
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation was aborted.", "AbortError");
}

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signalError(signal));
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signalError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([promise, aborted]).finally(removeAbortListener);
}

function disposeWithoutWaiting(
  dispose: (reason?: unknown) => Promise<void>,
  reason: unknown,
): void {
  try {
    void Promise.resolve(dispose(reason)).catch(() => undefined);
  } catch {
    // Cleanup cannot replace the invocation failure.
  }
}

function cancelReaderWithoutWaiting(
  reader: ReadableStreamDefaultReader<LlmAdapterFrame>,
  reason: unknown,
): void {
  const release = () => {
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative read may retain the lock after cancellation request.
    }
  };
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined).finally(
      release,
    );
  } catch {
    release();
  }
}

class FrameworkInvocationError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message, { cause });
    this.name = "FrameworkInvocationError";
  }
}

class InvocationBranchError extends Error {
  constructor(
    readonly branch: "provider" | "framework",
    readonly source: "result" | "frames",
    override readonly cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = "InvocationBranchError";
  }
}

function failureAttemptsFromResult(
  value: unknown,
  failure: unknown,
): readonly LlmAdapterAttempt[] {
  try {
    const result = plainRecord(value, "LLM Adapter result");
    if (!Array.isArray(result.attempts) || result.attempts.length === 0) {
      return Object.freeze([]);
    }
    const error = errorDetails(failure);
    return Object.freeze(result.attempts.map((attempt, index) => {
      const normalized = normalizedAdapterAttempt(
        attempt,
        `LLM Adapter result.attempts[${index}]`,
      );
      return Object.freeze({
        ...normalized,
        status: "failed" as const,
        error,
      });
    }));
  } catch {
    // Invalid accounting is never trusted merely because another result field
    // was invalid. The terminal Action error remains the source of failure.
    return Object.freeze([]);
  }
}

function rejectedAttempts(
  attempts: readonly LlmAdapterAttempt[],
  failure: unknown,
): readonly LlmAdapterAttempt[] {
  const error = errorDetails(failure);
  return Object.freeze(attempts.map((attempt) =>
    Object.freeze({
      ...attempt,
      status: "failed" as const,
      error,
    })
  ));
}

function normalizedRejectedAttemptEvidence(
  value: unknown,
): LlmRejectedAttemptEvidence | undefined {
  try {
    const record = plainRecord(value, "LLM rejected attempt evidence");
    exactKeys(
      record,
      new Set(["code", "message", "location", "retryable"]),
      "LLM rejected attempt evidence",
    );
    const code = requiredText(
      record.code,
      "LLM rejected attempt evidence.code",
    );
    const message = requiredText(
      record.message,
      "LLM rejected attempt evidence.message",
    );
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || message.length > 512) {
      return undefined;
    }
    const location = record.location === undefined
      ? undefined
      : requiredText(record.location, "LLM rejected attempt evidence.location");
    if (location && !/^[a-zA-Z0-9_.\[\]-]{1,128}$/.test(location)) {
      return undefined;
    }
    if (typeof record.retryable !== "boolean") return undefined;
    return Object.freeze({
      code,
      message,
      ...(location ? { location } : {}),
      retryable: record.retryable,
    });
  } catch {
    return undefined;
  }
}

function rejectedAttemptEvidence(
  error: unknown,
): LlmRejectedAttemptEvidence | undefined {
  if (error instanceof MalformedToolCallError) return error.evidence;
  if (error instanceof LlmAdapterCallError) {
    return normalizedRejectedAttemptEvidence(error.rejectedAttemptEvidence);
  }
  return undefined;
}

function frameworkFailureFromResult(
  value: unknown,
  failure: unknown,
): Error {
  const attempts = failureAttemptsFromResult(value, failure);
  if (attempts.length === 0) {
    return failure instanceof Error ? failure : new Error(String(failure));
  }
  const error = failure instanceof Error ? failure : new Error(String(failure));
  Object.defineProperty(error, "attempts", {
    value: attempts,
    enumerable: false,
    configurable: true,
  });
  return error;
}

async function drainFrames(
  reader: ReadableStreamDefaultReader<LlmAdapterFrame>,
  signal: AbortSignal,
): Promise<void> {
  try {
    while (true) {
      const next = await raceSignal(reader.read(), signal);
      if (next.done) return;
      // Deliberately discard: this runs only after Copilotz rejected a local
      // frame/result shape, so it must not publish more output while the
      // provider is allowed to finish and report its terminal usage.
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failing Reader may already have released its lock.
    }
  }
}

async function settleInvocation(
  invocation: ReturnType<LlmAdapter["call"]>,
  attempt: ResolvedModel,
  attemptIndex: number,
  input: LlmCallInput,
  context: LlmActionContext,
  state: StreamState,
  controller: AbortController,
  signal: AbortSignal,
  externalSignal: AbortSignal,
  disposeInput: (reason?: unknown) => Promise<void>,
): Promise<LlmAdapterResult> {
  // Observe and normalize the result before touching the frame stream. A
  // malformed or already-locked stream must never orphan a rejecting result.
  const result = observe(
    Promise.resolve(invocation.result).then((value) => {
      try {
        return invocationResult(value);
      } catch (error) {
        throw new FrameworkInvocationError(
          "LLM Adapter result failed Copilotz validation.",
          frameworkFailureFromResult(value, error),
        );
      }
    }),
  );
  let reader: ReadableStreamDefaultReader<LlmAdapterFrame>;
  try {
    reader = invocation.frames.getReader();
  } catch (error) {
    const resultOutcome = await Promise.allSettled([
      raceSignal(result, externalSignal),
    ]).then(([outcome]) => outcome!);
    if (externalSignal.aborted) {
      controller.abort(signalError(externalSignal));
      disposeWithoutWaiting(disposeInput, signalError(externalSignal));
      throw signalError(externalSignal);
    }
    let attempts: readonly LlmAdapterAttempt[] = Object.freeze([]);
    if (resultOutcome.status === "fulfilled") {
      attempts = rejectedAttempts(resultOutcome.value.attempts, error);
    } else {
      const failure = resultOutcome.reason instanceof FrameworkInvocationError
        ? resultOutcome.reason.cause
        : resultOutcome.reason;
      try {
        attempts = rejectedAttempts(normalizedFailureAttempts(failure), error);
      } catch {
        // The locked frame stream remains the authoritative local failure.
      }
    }
    controller.abort(error);
    disposeWithoutWaiting(disposeInput, error);
    if (attempts.length > 0) {
      throw new LlmAdapterCallError(
        "LLM provider response could not be consumed by Copilotz.",
        { attempts, cause: error },
      );
    }
    throw error;
  }
  const pumping = pumpFrames(
    reader,
    attempt,
    attemptIndex,
    input,
    context,
    state,
    signal,
  );
  observe(pumping);
  try {
    const settled = await Promise.all([
      raceSignal(result, signal).catch((error) => {
        throw new InvocationBranchError(
          error instanceof FrameworkInvocationError ? "framework" : "provider",
          "result",
          error,
        );
      }),
      raceSignal(pumping, signal).catch((error) => {
        throw new InvocationBranchError(
          error instanceof FrameworkInvocationError ? "framework" : "provider",
          "frames",
          error,
        );
      }),
    ]);
    reader.releaseLock();
    return settled[0];
  } catch (error) {
    if (
      error instanceof InvocationBranchError &&
      error.branch === "framework" && !externalSignal.aborted
    ) {
      // A Copilotz-side validation failure is not permission to abort the
      // provider request. Drain the raw frame branch and wait for its result,
      // which is where built-in providers expose final token accounting.
      state.discard = true;
      const frameSettlement = error.source === "result"
        ? pumping
        : drainFrames(reader, externalSignal);
      const [resultOutcome, drainOutcome] = await Promise.allSettled([
        raceSignal(result, externalSignal),
        frameSettlement,
      ]);
      if (error.source === "result") {
        try {
          reader.releaseLock();
        } catch {
          // The reader may already have settled through cancellation.
        }
      }
      if (externalSignal.aborted) throw signalError(externalSignal);
      if (resultOutcome.status === "fulfilled") {
        const evidence = rejectedAttemptEvidence(error.cause);
        throw new LlmAdapterCallError(
          "LLM provider response was rejected by Copilotz.",
          {
            attempts: rejectedAttempts(
              resultOutcome.value.attempts,
              error.cause,
            ),
            ...(evidence ? { rejectedAttemptEvidence: evidence } : {}),
            cause: error.cause,
          },
        );
      }
      if (resultOutcome.reason instanceof FrameworkInvocationError) {
        throw resultOutcome.reason.cause;
      }
      if (drainOutcome.status === "rejected") throw drainOutcome.reason;
      throw resultOutcome.reason;
    }
    controller.abort(error);
    disposeWithoutWaiting(disposeInput, error);
    cancelReaderWithoutWaiting(reader, error);
    throw error instanceof InvocationBranchError ? error.cause : error;
  }
}

async function abortWriters(
  state: StreamState,
  reason: unknown,
  outcome: "failed" | "cancelled" = "failed",
): Promise<void> {
  const message = reason instanceof Error ? reason.message : String(reason);
  const writers = [...state.writers.values()];
  state.writers.clear();
  await Promise.all(writers.map(async (opening) => {
    const writer = await opening.catch(() => undefined);
    await writer?.abort({ reason: message, outcome }).catch(() => undefined);
  }));
}

async function settleWriters(
  state: StreamState,
  signal: AbortSignal,
): Promise<readonly SettledStream[]> {
  const writers = [...state.writers.entries()];
  state.writers.clear();
  let failure: unknown;
  const settled: SettledStream[] = [];
  for (const [key, opening] of writers) {
    let writer: OpenWriter | undefined;
    try {
      writer = await opening;
      if (failure !== undefined) {
        await writer.abort({ reason: "Another LLM output stream failed." });
        continue;
      }
      const prepared = await writer.close({ assetId: `stream:${writer.id}` }, {
        signal,
      });
      const [lane, mediaType] = JSON.parse(key) as [string, string];
      settled.push(Object.freeze({
        key,
        lane,
        mediaType,
        writer,
        prepared,
      }));
    } catch (error) {
      failure ??= error;
      await writer?.abort({
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }
  if (failure !== undefined) throw failure;
  return Object.freeze(settled);
}

function errorDetails(error: unknown): Readonly<{
  code?: string;
  message: string;
}> {
  const record = isRecord(error) ? error : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
    ? record.message
    : String(error);
  const code = typeof record?.code === "string" && record.code.trim()
    ? record.code.trim()
    : undefined;
  return Object.freeze({
    ...(code ? { code } : {}),
    message: message.slice(0, 2_000),
  });
}

function durableAttempt(
  candidate: ResolvedModel,
  index: number,
  context: LlmActionContext,
  attempt: LlmAdapterAttempt,
  providerRequest: boolean,
  fallbackError?: unknown,
): LlmAttemptUsage {
  const error = attempt.error ??
    (fallbackError === undefined ? undefined : errorDetails(fallbackError));
  return Object.freeze({
    id: `${context.action.runId}:attempt:${index}`,
    index,
    providerRequest,
    connection: candidate.alias,
    ...(candidate.connection.provider
      ? { provider: candidate.connection.provider }
      : {}),
    model: candidate.selection.model,
    adapter: candidate.adapterAlias,
    providerModel: candidate.selection.model,
    status: attempt.status,
    ...(attempt.usage ? { usage: structuredClone(attempt.usage) } : {}),
    ...(attempt.finishReason ? { finishReason: attempt.finishReason } : {}),
    ...(error ? { error: structuredClone(error) } : {}),
    ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
  });
}

function normalizedFailureAttempts(
  error: unknown,
): readonly LlmAdapterAttempt[] {
  const source = error instanceof LlmAdapterCallError
    ? error.attempts
    : isRecord(error) && Array.isArray(error.attempts)
    ? error.attempts
    : undefined;
  if (!source) return Object.freeze([]);
  const attempts = Object.freeze(
    source.map((attempt, index) =>
      normalizedAdapterAttempt(
        attempt,
        `LLM Adapter error.attempts[${index}]`,
      )
    ),
  );
  if (attempts.some((attempt) => attempt.status === "completed")) {
    throw new TypeError(
      "A rejected LLM Adapter invocation cannot report a completed attempt.",
    );
  }
  return attempts;
}

function appendDurableAttempts(
  target: LlmAttemptUsage[],
  candidate: ResolvedModel,
  context: LlmActionContext,
  attempts: readonly LlmAdapterAttempt[],
  fallbackStatus: LlmAdapterAttempt["status"],
  error?: unknown,
): void {
  const values = attempts.length > 0
    ? attempts
    : [Object.freeze({ status: fallbackStatus })];
  const providerRequest = attempts.length > 0;
  for (const [localIndex, attempt] of values.entries()) {
    target.push(durableAttempt(
      candidate,
      target.length,
      context,
      attempt,
      providerRequest,
      localIndex === values.length - 1 ? error : undefined,
    ));
  }
}

async function reportAttemptAccounting(
  attempts: readonly LlmAttemptUsage[],
  context: LlmActionContext,
): Promise<void> {
  const providerAttempts = attempts.filter((attempt) =>
    attempt.providerRequest
  );
  if (providerAttempts.length === 0) return;
  await context.progress({
    schema: LLM_ATTEMPT_ACCOUNTING_SCHEMA,
    attempts: providerAttempts,
  });
}

async function reportRejectedAttemptEvidence(
  evidence: LlmRejectedAttemptEvidence | undefined,
  attempt: LlmAttemptUsage | undefined,
  context: LlmActionContext,
): Promise<void> {
  if (!evidence || !attempt) return;
  await context.progress({
    schema: LLM_REJECTED_ATTEMPT_EVIDENCE_SCHEMA,
    attempt: {
      id: attempt.id,
      index: attempt.index,
      model: attempt.model,
      adapter: attempt.adapter,
      providerModel: attempt.providerModel,
    },
    evidence,
  });
}

async function failWithAttemptAccounting(
  error: unknown,
  attempts: readonly LlmAttemptUsage[],
  context: LlmActionContext,
): Promise<never> {
  await reportAttemptAccounting(attempts, context);
  throw error;
}

const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
] as const;

function aggregateUsage(
  attempts: readonly LlmAttemptUsage[],
): LlmUsage | undefined {
  const sums: Partial<Record<(typeof USAGE_TOKEN_FIELDS)[number], number>> = {};
  const overflowed = new Set<(typeof USAGE_TOKEN_FIELDS)[number]>();
  let totalTokens = 0;
  let hasTotalTokens = false;
  let totalTokensOverflowed = false;
  const costs: Array<Readonly<{ amount: number; currency: string }>> = [];
  let hasUsage = false;
  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (!usage) continue;
    hasUsage = true;
    for (const field of USAGE_TOKEN_FIELDS) {
      const amount = usage[field];
      if (amount === undefined || overflowed.has(field)) continue;
      const aggregate = (sums[field] ?? 0) + amount;
      if (Number.isSafeInteger(aggregate)) sums[field] = aggregate;
      else {
        delete sums[field];
        overflowed.add(field);
      }
    }
    const attemptTotal = usage.totalTokens ??
      (usage.inputTokens !== undefined || usage.outputTokens !== undefined
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : undefined);
    if (attemptTotal !== undefined && !totalTokensOverflowed) {
      const aggregate = totalTokens + attemptTotal;
      if (Number.isSafeInteger(aggregate)) {
        totalTokens = aggregate;
        hasTotalTokens = true;
      } else {
        totalTokens = 0;
        hasTotalTokens = false;
        totalTokensOverflowed = true;
      }
    }
    if (usage.cost) costs.push(usage.cost);
  }
  if (!hasUsage) return undefined;
  const currencies = new Set(costs.map((cost) => cost.currency));
  const costAmount = costs.reduce((sum, item) => sum + item.amount, 0);
  const cost = costs.length > 0 && currencies.size === 1 &&
      Number.isFinite(costAmount)
    ? Object.freeze({ amount: costAmount, currency: costs[0].currency })
    : undefined;
  return Object.freeze({
    ...sums,
    ...(hasTotalTokens ? { totalTokens } : {}),
    ...(cost ? { cost } : {}),
  });
}

function invocationResult(value: unknown): LlmAdapterResult {
  const record = plainRecord(value, "LLM Adapter result");
  exactKeys(
    record,
    new Set([
      "content",
      "reasoning",
      "nativeReasoning",
      "toolCalls",
      "attempts",
      "finishReason",
    ]),
    "LLM Adapter result",
  );
  if (!("content" in record)) {
    throw new TypeError("LLM Adapter returned an invalid result.");
  }
  const content = normalizedContent(
    record.content,
    "LLM Adapter result.content",
  );
  const reasoning = record.reasoning === undefined
    ? undefined
    : normalizedContent(record.reasoning, "LLM Adapter result.reasoning");
  const nativeReasoning = record.nativeReasoning === undefined
    ? undefined
    : normalizedNativeReasoningResult(
      record.nativeReasoning,
      "LLM Adapter result.nativeReasoning",
    );
  const toolCalls = record.toolCalls === undefined
    ? undefined
    : normalizedToolCalls(record.toolCalls);
  if (!Array.isArray(record.attempts) || record.attempts.length === 0) {
    throw new TypeError(
      "LLM Adapter result.attempts must be a non-empty array.",
    );
  }
  const attempts = Object.freeze(
    record.attempts.map((attempt, index) =>
      normalizedAdapterAttempt(
        attempt,
        `LLM Adapter result.attempts[${index}]`,
      )
    ),
  );
  const finishReason = optionalText(
    record.finishReason,
    "LLM Adapter result.finishReason",
  );
  return Object.freeze({
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(nativeReasoning ? { nativeReasoning } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    attempts,
    ...(finishReason ? { finishReason } : {}),
  });
}

function invocationOf(value: unknown): Readonly<{
  frames: ReadableStream<LlmAdapterFrame>;
  result: Promise<LlmAdapterResult>;
}> {
  if (isRecord(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "result");
    if (descriptor && "value" in descriptor && descriptor.value !== undefined) {
      // Invalid invocation shapes must not strand an already-running result.
      void Promise.resolve(descriptor.value).catch(() => undefined);
    }
  }
  const record = plainRecord(value, "LLM Adapter invocation");
  exactKeys(record, new Set(["frames", "result"]), "LLM Adapter invocation");
  if (!(record.frames instanceof ReadableStream)) {
    throw new TypeError("LLM Adapter returned an invalid invocation.");
  }
  if (
    !record.result ||
    typeof (record.result as PromiseLike<unknown>).then !== "function"
  ) {
    throw new TypeError("LLM Adapter invocation requires a result Promise.");
  }
  return record as ReturnType<LlmAdapter["call"]>;
}

function matchingSettledStream(
  lane: "content" | "reasoning",
  prepared: PreparedContent,
  streams: readonly SettledStream[],
): { stream: SettledStream; prepared: PreparedContent } | undefined {
  const candidates = streams.filter((stream) => stream.lane === lane);
  if (candidates.length !== 1) return undefined;
  const stream = candidates[0];
  const adopted = adoptPreparedBody(prepared, stream.prepared);
  return adopted ? { stream, prepared: adopted } : undefined;
}

async function retainSettledStream(
  stream: SettledStream,
  input: Readonly<
    | { retention: "canonical"; assetId: string }
    | { retention: "observation" }
  >,
): Promise<void> {
  if (input.retention === "canonical") {
    await stream.writer.retain({
      retention: "canonical",
      assetId: input.assetId,
    });
    return;
  }
  await stream.writer.retain({ retention: "observation" });
}

async function materializeResultContent(
  result: LlmAdapterResult,
  attemptIndex: number,
  streams: readonly SettledStream[],
  context: LlmActionContext,
): Promise<
  Readonly<{
    content: ContentSequence;
    reasoning?: ContentSequence;
    nativeReasoning?: ContentSequence;
  }>
> {
  const contentPrepared = await context.content.prepare(result.content, {
    operationKey: `attempt:${attemptIndex}:content`,
  });
  const reasoningPrepared = result.reasoning === undefined
    ? undefined
    : await context.content.prepare(result.reasoning, {
      operationKey: `attempt:${attemptIndex}:reasoning`,
    });
  const nativeReasoningPrepared = result.nativeReasoning === undefined
    ? undefined
    : await context.content.prepare(result.nativeReasoning.blocks, {
      operationKey: `attempt:${attemptIndex}:native-reasoning`,
    });
  const contentStream = matchingSettledStream(
    "content",
    contentPrepared,
    streams,
  );
  const reasoningStream = reasoningPrepared
    ? matchingSettledStream("reasoning", reasoningPrepared, streams)
    : undefined;
  const adopted = new Set(
    [contentStream?.stream, reasoningStream?.stream].filter(
      (value): value is SettledStream => value !== undefined,
    ).map((value) => value.key),
  );

  // Non-equivalent and non-semantic lanes remain observation-only Bodies for
  // the reconnect retention window. Exact matches reuse the already-sealed
  // Body under the canonical final Asset identity and materialize only once.
  for (const stream of streams) {
    if (!adopted.has(stream.key)) {
      await retainSettledStream(
        stream,
        { retention: "observation" },
      );
    }
  }
  const content = await context.content.materialize(
    contentStream?.prepared ?? contentPrepared,
  );
  const reasoning = reasoningPrepared === undefined
    ? undefined
    : await context.content.materialize(
      reasoningStream?.prepared ?? reasoningPrepared,
    );
  const nativeReasoning = nativeReasoningPrepared === undefined
    ? undefined
    : await context.content.materialize(nativeReasoningPrepared);
  if (contentStream && content.length === 1) {
    await retainSettledStream(
      contentStream.stream,
      { retention: "canonical", assetId: content[0].assetId },
    );
  }
  if (reasoningStream && reasoning?.length === 1) {
    await retainSettledStream(
      reasoningStream.stream,
      { retention: "canonical", assetId: reasoning[0].assetId },
    );
  }
  return Object.freeze({
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(nativeReasoning ? { nativeReasoning } : {}),
  });
}

function outputFor(
  selected: ResolvedModel,
  result: LlmAdapterResult,
  content: ContentSequence,
  reasoning: ContentSequence | undefined,
  nativeReasoning: ContentSequence | undefined,
  attempts: readonly LlmAttemptUsage[],
): LlmCallOutput {
  const usage = aggregateUsage(attempts);
  return Object.freeze({
    adapter: selected.adapterAlias,
    connection: selected.alias,
    model: selected.selection.model,
    providerModel: selected.selection.model,
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(result.nativeReasoning && nativeReasoning
      ? {
        nativeReasoning: {
          schema: "copilotz.llm-native-reasoning.v1" as const,
          adapter: selected.adapterAlias,
          api: result.nativeReasoning.api,
          model: selected.selection.model,
          blocks: nativeReasoning,
        },
      }
      : {}),
    ...(result.toolCalls
      ? { toolCalls: Object.freeze(structuredClone(result.toolCalls)) }
      : {}),
    ...(usage ? { usage } : {}),
    attempts: Object.freeze(attempts),
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  });
}

async function executeLlmCall(
  rawInput: LlmCallInput,
  context: LlmActionContext,
): Promise<LlmCallOutput> {
  const input = normalizedCallInput(rawInput);
  const plan = modelPlan(input.models, input.mode, context);
  const attempts: LlmAttemptUsage[] = [];
  const credentialMemo = new Map<
    string,
    Promise<LlmAuthResolution | undefined>
  >();

  for (let index = 0; index < plan.length; index += 1) {
    if (context.signal.aborted) {
      await failWithAttemptAccounting(
        signalError(context.signal),
        attempts,
        context,
      );
    }
    const prepared = await attemptModel(
      plan[index],
      input,
      context,
      credentialMemo,
    );
    if (context.signal.aborted) {
      await failWithAttemptAccounting(
        signalError(context.signal),
        attempts,
        context,
      );
    }
    // Connected-account credentials may be unavailable for this user. This is
    // an intentional no-I/O skip, not a provider attempt or Usage record.
    if (prepared.kind === "unavailable") continue;
    if (prepared.kind === "failed") {
      const failure = Object.assign(
        new Error("LLM credential resolution failed."),
        { code: "credential_unavailable" },
      );
      appendDurableAttempts(
        attempts,
        plan[index],
        context,
        Object.freeze([]),
        "failed",
        failure,
      );
      if (index === plan.length - 1) {
        await failWithAttemptAccounting(failure, attempts, context);
      }
      continue;
    }
    const candidate = prepared.candidate;
    const request = projectPreparedRequest(
      input.request,
      context.namespace,
      {
        adapter: candidate.adapterAlias,
        model: candidate.selection.model,
      },
    );
    const streams: StreamState = {
      writers: new Map(),
      visible: false,
      discard: false,
    };
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([
      context.signal,
      attemptController.signal,
    ]);
    let attemptInput: ManagedInput | undefined;
    let result: LlmAdapterResult;
    try {
      // The same guard applies to custom adapters and replayed prepared inputs.
      preflightLlmRequest(input.request, {
        ...candidate.selection.options,
        model: candidate.selection.model,
        ...(candidate.connection.provider
          ? { provider: candidate.connection.provider }
          : {}),
      }, context.namespace);
      const inputFollower = input.inputStreamId
        ? await context.streams.follow({
          id: requiredText(input.inputStreamId, "LLM input stream ID"),
        }, { signal: attemptSignal })
        : undefined;
      attemptInput = inputFollower
        ? managedInput(inputFollower.body)
        : undefined;
      const invocation = invocationOf(candidate.adapter!.call({
        model: candidate.selection.model,
        adapter: candidate.adapterAlias,
        providerModel: candidate.selection.model,
        mode: input.mode,
        fallbackAvailable: index < plan.length - 1,
        options: candidate.selection.options ?? Object.freeze({}),
        request,
        signal: attemptSignal,
        ...(attemptInput ? { input: attemptInput.stream } : {}),
      }));
      result = await settleInvocation(
        invocation,
        candidate,
        index,
        input,
        context,
        streams,
        attemptController,
        attemptSignal,
        context.signal,
        (reason) => attemptInput?.dispose(reason) ?? Promise.resolve(),
      );
      if (attemptInput) {
        disposeWithoutWaiting(
          attemptInput.dispose,
          "LLM attempt input settled.",
        );
      }
    } catch (error) {
      attemptController.abort(error);
      if (attemptInput) disposeWithoutWaiting(attemptInput.dispose, error);
      const cancelled = isAbort(error, context.signal);
      await abortWriters(streams, error, cancelled ? "cancelled" : "failed");
      let failure = error;
      const evidence = rejectedAttemptEvidence(error);
      let reported: readonly LlmAdapterAttempt[] = Object.freeze([]);
      try {
        reported = normalizedFailureAttempts(error);
      } catch (validationError) {
        failure = validationError;
      }
      appendDurableAttempts(
        attempts,
        candidate,
        context,
        reported,
        cancelled ? "cancelled" : "failed",
        failure,
      );
      await reportRejectedAttemptEvidence(evidence, attempts.at(-1), context);
      const terminalFailure = cancelled ||
        streams.visible ||
        index === plan.length - 1;
      if (terminalFailure) {
        await failWithAttemptAccounting(failure, attempts, context);
      }
      continue;
    }

    let resultAccounted = false;
    try {
      const settledStreams = await settleWriters(streams, attemptSignal);
      appendDurableAttempts(
        attempts,
        candidate,
        context,
        result.attempts,
        "completed",
      );
      resultAccounted = true;
      const { content, reasoning, nativeReasoning } =
        await materializeResultContent(
          result,
          index,
          settledStreams,
          context,
        );
      return outputFor(
        candidate,
        result,
        content,
        reasoning,
        nativeReasoning,
        attempts,
      );
    } catch (error) {
      if (!resultAccounted) {
        appendDurableAttempts(
          attempts,
          candidate,
          context,
          result.attempts,
          "completed",
        );
      }
      await failWithAttemptAccounting(error, attempts, context);
    }
  }

  return await failWithAttemptAccounting(
    new Error("No LLM credential is available for the configured selections."),
    attempts,
    context,
  );
}

export const callLlmAction: ActionDefinition<
  LlmCallInput,
  LlmCallOutput,
  LlmActionContext,
  typeof llmCallInputSchema,
  undefined
> = defineAction({
  id: LLM_CALL_ACTION_ID,
  inputSchema: llmCallInputSchema,
  content: {
    input: [
      "request.messages[].content",
      "request.messages[].reasoning",
      "request.messages[].nativeReasoning.blocks",
    ],
  },
  execute: executeLlmCall,
});

export type {
  LlmAdapterNativeReasoning,
  LlmAttemptStatus,
  LlmAttemptUsage,
  LlmCallInput,
  LlmCallOutput,
  LlmCost,
  LlmMessage,
  LlmNativeReasoning,
  LlmNativeReasoningInput,
  LlmRequest,
  LlmStreamDescriptor,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolPipeline,
  LlmToolPipelineJqStage,
  LlmToolPipelineStage,
  LlmToolPipelineToolStage,
  LlmUsage,
} from "../../internal/contracts.ts";
