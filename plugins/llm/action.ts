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
  ResolvedContent,
} from "@copilotz/copilotz/content";
import {
  defineModel,
  type LlmAdapter,
  type LlmAdapterAttempt,
  LlmAdapterCallError,
  type LlmAdapterContentPart,
  type LlmAdapterFrame,
  type LlmAdapterMessage,
  type LlmAdapterRequest,
  type LlmAdapterResult,
  type LlmAttemptUsage,
  type LlmCallInput,
  type LlmCallOutput,
  type LlmJsonObject,
  type LlmMessage,
  type LlmToolCall,
  type LlmUsage,
  type ModelResource,
} from "./contracts.ts";

export const LLM_CALL_ACTION_ID = "llm.call";
export const LLM_CALL_ACTION_ALIAS = "callLlm";

export type LlmActionResources = Readonly<{
  models: Readonly<Record<string, ModelResource | undefined>>;
}>;

export type LlmActionAdapters = Readonly<{
  llm: Readonly<Record<string, LlmAdapter | undefined>>;
}>;

/** Composed context expected by the provider-neutral LLM Action. */
export interface LlmActionContext
  extends ActionContext<LlmActionResources, LlmActionAdapters> {}

type ResolvedModel = Readonly<{
  alias: string;
  resource: ModelResource;
  adapter: LlmAdapter;
}>;

type OpenWriter = Awaited<ReturnType<LlmActionContext["streams"]["open"]>>;

type StreamState = {
  writers: Map<string, Promise<OpenWriter>>;
  visible: boolean;
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
  adapters: LlmActionAdapters["llm"],
): LlmAdapter {
  const adapter = adapters[alias];
  if (!adapter || !isRecord(adapter) || typeof adapter.call !== "function") {
    throw new Error(`Unknown LLM adapter '${alias}'.`);
  }
  return adapter;
}

/**
 * Validates the complete reachable graph before the first provider call and
 * flattens it depth-first in declared fallback priority.
 */
function modelPlan(
  requested: string,
  context: LlmActionContext,
): readonly ResolvedModel[] {
  const models = context.resources.models;
  const adapters = context.adapters.llm;
  if (!isRecord(models)) {
    throw new TypeError("LLM resources.models must be an alias map.");
  }
  if (!isRecord(adapters)) {
    throw new TypeError("LLM adapters.llm must be an alias map.");
  }

  const plan: ResolvedModel[] = [];
  const complete = new Set<string>();
  const active: string[] = [];

  const visit = (alias: string): void => {
    const cycleAt = active.indexOf(alias);
    if (cycleAt >= 0) {
      const cycle = [...active.slice(cycleAt), alias].join(" -> ");
      throw new Error(`LLM Model fallback cycle: ${cycle}.`);
    }
    if (complete.has(alias)) return;

    const candidate = models[alias];
    if (!candidate) throw new Error(`Unknown LLM Model '${alias}'.`);
    const resource = defineModel(candidate);
    const adapter = adapterFor(resource.adapter, adapters);

    active.push(alias);
    plan.push(Object.freeze({ alias, resource, adapter }));
    for (const fallback of resource.fallbacks ?? []) visit(fallback);
    active.pop();
    complete.add(alias);
  };

  visit(requested);
  return Object.freeze(plan);
}

function contentFields(ref: ContentRef): Readonly<Record<string, unknown>> {
  return {
    role: ref.role,
    mediaType: ref.mediaType,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.alt ? { alt: ref.alt } : {}),
    ...(ref.language ? { language: ref.language } : {}),
    ...(ref.disposition ? { disposition: ref.disposition } : {}),
    ...(ref.metadata ? { metadata: structuredClone(ref.metadata) } : {}),
  };
}

function resolvedPart(value: ResolvedContent): LlmAdapterContentPart {
  const { ref } = value;
  const fields = contentFields(ref);
  if (ref.kind === "text") {
    return Object.freeze({
      type: "text",
      text: value.text ?? new TextDecoder().decode(value.bytes),
      ...fields,
    }) as LlmAdapterContentPart;
  }
  if (ref.kind === "json") {
    let json = value.value;
    if (json === undefined) {
      try {
        json = JSON.parse(value.text ?? new TextDecoder().decode(value.bytes));
      } catch (cause) {
        throw new TypeError(
          `LLM content '${ref.assetId}' is not valid JSON.`,
          { cause },
        );
      }
    }
    return Object.freeze({
      type: "json",
      value: structuredClone(json),
      ...fields,
    }) as LlmAdapterContentPart;
  }
  return Object.freeze({
    type: ref.kind,
    bytes: value.bytes.slice(),
    ...fields,
  }) as LlmAdapterContentPart;
}

async function resolveMessage(
  message: LlmMessage,
  context: LlmActionContext,
): Promise<LlmAdapterMessage> {
  const resolved = await context.content.resolveMany(message.content);
  if (resolved.length !== message.content.length) {
    throw new Error("LLM content resolution returned an incomplete sequence.");
  }
  for (let index = 0; index < resolved.length; index += 1) {
    if (resolved[index].ref.assetId !== message.content[index].assetId) {
      throw new Error("LLM content resolution changed sequence order.");
    }
  }
  const content = Object.freeze(resolved.map(resolvedPart));
  const common = {
    content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.metadata
      ? { metadata: structuredClone(message.metadata) }
      : {}),
  };
  if (message.role === "assistant") {
    return Object.freeze({
      role: message.role,
      ...common,
      ...(message.toolCalls
        ? { toolCalls: structuredClone(message.toolCalls) }
        : {}),
    });
  }
  if (message.role === "tool") {
    return Object.freeze({
      role: message.role,
      ...common,
      toolCallId: requiredText(message.toolCallId, "LLM tool-call ID"),
    });
  }
  return Object.freeze({ role: message.role, ...common });
}

async function resolveRequest(
  input: LlmCallInput,
  context: LlmActionContext,
): Promise<LlmAdapterRequest> {
  if (!isRecord(input.request) || !Array.isArray(input.request.messages)) {
    throw new TypeError("LLM request.messages must be an array.");
  }
  const messages = await Promise.all(
    input.request.messages.map((message) => resolveMessage(message, context)),
  );
  return Object.freeze({
    messages: Object.freeze(messages),
    ...(input.request.tools
      ? { tools: Object.freeze(structuredClone(input.request.tools)) }
      : {}),
    ...(input.request.instructions !== undefined
      ? { instructions: input.request.instructions }
      : {}),
  });
}

function optionsFor(
  resource: ModelResource,
  options: LlmJsonObject | undefined,
): LlmJsonObject {
  return jsonObject({
    ...(resource.options ?? {}),
    ...(options ?? {}),
  }, "LLM Adapter options");
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

function normalizedToolCalls(value: unknown): readonly LlmToolCall[] {
  if (!Array.isArray(value)) {
    throw new TypeError("LLM Adapter result.toolCalls must be an array.");
  }
  const ids = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    const path = `LLM Adapter result.toolCalls[${index}]`;
    const record = plainRecord(item, path);
    exactKeys(record, new Set(["id", "action", "input"]), path);
    const id = requiredText(record.id, `${path}.id`);
    if (ids.has(id)) {
      throw new TypeError(
        `LLM Adapter result.toolCalls has duplicate id '${id}'.`,
      );
    }
    ids.add(id);
    return Object.freeze({
      id,
      action: requiredText(record.action, `${path}.action`),
      input: jsonObject(record.input, `${path}.input`),
    });
  }));
}

function normalizedMessage(value: unknown, index: number): LlmMessage {
  const path = `LLM request.messages[${index}]`;
  const record = plainRecord(value, path);
  const role = requiredText(record.role, `${path}.role`);
  const commonKeys = ["role", "content", "name", "metadata"];
  const allowed = role === "assistant"
    ? new Set([...commonKeys, "toolCalls"])
    : role === "tool"
    ? new Set([...commonKeys, "toolCallId"])
    : new Set(commonKeys);
  exactKeys(record, allowed, path);
  if (!["system", "user", "assistant", "tool"].includes(role)) {
    throw new TypeError(`${path}.role is invalid.`);
  }
  if (!Array.isArray(record.content)) {
    throw new TypeError(`${path}.content must be a ContentSequence.`);
  }
  const content = Object.freeze(record.content.map((item, contentIndex) => {
    const normalized = normalizedContentInput(
      item,
      `${path}.content[${contentIndex}]`,
    );
    if (typeof normalized === "string" || !("assetId" in normalized)) {
      throw new TypeError(`${path}.content must contain only ContentRefs.`);
    }
    return normalized;
  }));
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
    });
  }
  if (role === "tool") {
    return Object.freeze({
      role,
      ...common,
      toolCallId: requiredText(record.toolCallId, `${path}.toolCallId`),
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
    new Set(["model", "request", "stream", "inputStreamId", "options"]),
    "LLM call input",
  );
  const model = requiredText(record.model, "LLM Model alias");
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
  const options = record.options === undefined
    ? undefined
    : jsonObject(record.options, "LLM call options");
  return Object.freeze({
    model,
    request,
    ...(stream ? { stream } : {}),
    ...(inputStreamId ? { inputStreamId } : {}),
    ...(options ? { options } : {}),
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
  return `${frame.lane}\u0000${frame.mediaType}`;
}

function streamSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

async function writerFor(
  frame: LlmAdapterFrame,
  attempt: ResolvedModel,
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
    const base = input.stream.id?.trim() || context.action.runId;
    const id = `${base}:${streamSegment(lane)}:${streamSegment(mediaType)}`;
    opening = context.streams.open({
      id,
      role: lane,
      mediaType,
      metadata: {
        ...(input.stream.metadata ?? {}),
        lane,
        model: attempt.alias,
        adapter: attempt.resource.adapter,
      },
      ...(context.identity.correlationId
        ? { correlationId: context.identity.correlationId }
        : {}),
    }, { signal });
    state.writers.set(key, opening);
  }
  const writer = await opening;
  // Opening publishes the stream descriptor, so output is visible from here.
  state.visible = true;
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
  while (true) {
    throwIfAborted(signal);
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
    const next = await Promise.race([reader.read(), aborted]).finally(
      removeAbortListener,
    );
    if (next.done) return;
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
    if (frame.bytes.byteLength === 0) continue;
    const writer = await writerFor(
      frame,
      attempt,
      input,
      context,
      state,
      signal,
    );
    if (writer) {
      await writer.append({
        bytes: frame.bytes,
        appendId:
          `${context.action.runId}:attempt:${attemptIndex}:frame:${frameIndex}`,
      }, { signal });
    }
    frameIndex += 1;
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

async function settleInvocation(
  invocation: ReturnType<LlmAdapter["call"]>,
  attempt: ResolvedModel,
  attemptIndex: number,
  input: LlmCallInput,
  context: LlmActionContext,
  state: StreamState,
  controller: AbortController,
  signal: AbortSignal,
  disposeInput: (reason?: unknown) => Promise<void>,
): Promise<LlmAdapterResult> {
  // Observe and normalize the result before touching the frame stream. A
  // malformed or already-locked stream must never orphan a rejecting result.
  const result = observe(
    Promise.resolve(invocation.result).then(
      invocationResult,
    ),
  );
  let reader: ReadableStreamDefaultReader<LlmAdapterFrame>;
  try {
    reader = invocation.frames.getReader();
  } catch (error) {
    controller.abort(error);
    disposeWithoutWaiting(disposeInput, error);
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
      raceSignal(result, signal),
      raceSignal(pumping, signal),
    ]);
    reader.releaseLock();
    return settled[0];
  } catch (error) {
    controller.abort(error);
    disposeWithoutWaiting(disposeInput, error);
    cancelReaderWithoutWaiting(reader, error);
    throw error;
  }
}

async function abortWriters(
  state: StreamState,
  reason: unknown,
): Promise<void> {
  const message = reason instanceof Error ? reason.message : String(reason);
  const writers = [...state.writers.values()];
  state.writers.clear();
  await Promise.all(writers.map(async (opening) => {
    const writer = await opening.catch(() => undefined);
    await writer?.abort({ reason: message }).catch(() => undefined);
  }));
}

async function settleWriters(
  state: StreamState,
  context: LlmActionContext,
  signal: AbortSignal,
): Promise<void> {
  const writers = [...state.writers.values()];
  state.writers.clear();
  let failure: unknown;
  for (const opening of writers) {
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
      await context.content.materialize(prepared);
    } catch (error) {
      failure ??= error;
      await writer?.abort({
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }
  if (failure !== undefined) throw failure;
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
  fallbackError?: unknown,
): LlmAttemptUsage {
  const error = attempt.error ??
    (fallbackError === undefined ? undefined : errorDetails(fallbackError));
  return Object.freeze({
    id: `${context.action.runId}:attempt:${index}`,
    index,
    adapter: candidate.resource.adapter,
    providerModel: candidate.resource.model,
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
  if (!(error instanceof LlmAdapterCallError)) return Object.freeze([]);
  const attempts = Object.freeze(
    error.attempts.map((attempt, index) =>
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
  for (const [localIndex, attempt] of values.entries()) {
    target.push(durableAttempt(
      candidate,
      target.length,
      context,
      attempt,
      localIndex === values.length - 1 ? error : undefined,
    ));
  }
}

const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
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

async function materialize(
  input: ContentInput | readonly ContentInput[],
  operationKey: string,
  context: LlmActionContext,
): Promise<ContentSequence> {
  const prepared = await context.content.prepare(input, { operationKey });
  return await context.content.materialize(prepared);
}

function outputFor(
  selected: ResolvedModel,
  result: LlmAdapterResult,
  content: ContentSequence,
  reasoning: ContentSequence | undefined,
  attempts: readonly LlmAttemptUsage[],
): LlmCallOutput {
  const usage = aggregateUsage(attempts);
  return Object.freeze({
    model: selected.alias,
    adapter: selected.resource.adapter,
    providerModel: selected.resource.model,
    content,
    ...(reasoning ? { reasoning } : {}),
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
  const requested = input.model;
  const plan = modelPlan(requested, context);
  const request = await resolveRequest(input, context);
  const attempts: LlmAttemptUsage[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    throwIfAborted(context.signal);
    const candidate = plan[index];
    const streams: StreamState = { writers: new Map(), visible: false };
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([
      context.signal,
      attemptController.signal,
    ]);
    let attemptInput: ManagedInput | undefined;
    let result: LlmAdapterResult;
    try {
      const inputFollower = input.inputStreamId
        ? await context.streams.follow({
          id: requiredText(input.inputStreamId, "LLM input stream ID"),
        }, { signal: attemptSignal })
        : undefined;
      attemptInput = inputFollower
        ? managedInput(inputFollower.body)
        : undefined;
      const invocation = invocationOf(candidate.adapter.call({
        model: candidate.alias,
        adapter: candidate.resource.adapter,
        providerModel: candidate.resource.model,
        mode: candidate.resource.mode ?? "generate",
        fallbackAvailable: index < plan.length - 1,
        options: optionsFor(candidate.resource, input.options),
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
      await abortWriters(streams, error);
      let failure = error;
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
        isAbort(error, context.signal) ? "cancelled" : "failed",
        failure,
      );
      if (
        isAbort(error, context.signal) || streams.visible ||
        index === plan.length - 1
      ) throw failure;
      continue;
    }

    await settleWriters(streams, context, attemptSignal);
    appendDurableAttempts(
      attempts,
      candidate,
      context,
      result.attempts,
      "completed",
    );
    const content = await materialize(
      result.content,
      `attempt:${index}:content`,
      context,
    );
    const reasoning = result.reasoning === undefined
      ? undefined
      : await materialize(
        result.reasoning,
        `attempt:${index}:reasoning`,
        context,
      );
    return outputFor(
      candidate,
      result,
      content,
      reasoning,
      attempts,
    );
  }

  throw new Error("LLM call had no configured Model attempt.");
}

export const callLlmAction: ActionDefinition<
  LlmCallInput,
  LlmCallOutput,
  LlmActionContext,
  undefined,
  undefined
> = defineAction({
  id: LLM_CALL_ACTION_ID,
  execute: executeLlmCall,
});
