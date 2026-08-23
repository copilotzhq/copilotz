import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import { bytesToBase64, type ContentInput } from "@copilotz/copilotz/content";
import { cloneGoalJson } from "./resource.ts";
import type {
  GoalCancelInput,
  GoalCancelRequest,
  GoalContentInput,
  GoalStartInput,
  GoalStartRequest,
} from "./types.ts";

export const GOAL_START_INPUT_EVENT = "copilotz.goals.start.input";
export const GOAL_CANCEL_INPUT_EVENT = "copilotz.goals.cancel.input";

export type GoalStartInputEnvelope = CopilotzInputEnvelope<
  typeof GOAL_START_INPUT_EVENT,
  GoalStartInput
>;
export type GoalCancelInputEnvelope = CopilotzInputEnvelope<
  typeof GOAL_CANCEL_INPUT_EVENT,
  GoalCancelInput
>;
export type GoalInputHelpers = Readonly<{
  start(input: GoalStartRequest): GoalStartInputEnvelope;
  cancel(input: GoalCancelRequest): GoalCancelInputEnvelope;
}>;

const START_KEYS = new Set([
  "goal",
  "content",
  "sender",
  "thread",
  "id",
  "metadata",
  "namespace",
  "databaseSchema",
  "correlationId",
  "causationId",
  "deduplicationId",
]);
const CANCEL_KEYS = new Set([
  "goalId",
  "reason",
  "namespace",
  "databaseSchema",
  "correlationId",
  "causationId",
  "deduplicationId",
]);
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
const CONTENT_TEXT_KEYS = new Set([
  "type",
  "text",
  "role",
  "mediaType",
  "name",
  "language",
  "metadata",
  "origin",
]);
const CONTENT_JSON_KEYS = new Set([
  "type",
  "value",
  "role",
  "mediaType",
  "name",
  "metadata",
  "origin",
]);
const CONTENT_MEDIA_KEYS = new Set([
  "type",
  "bytes",
  "mediaType",
  "role",
  "name",
  "alt",
  "language",
  "disposition",
  "metadata",
  "origin",
]);
const SENDER_KEYS = new Set(["id", "externalId", "name", "email", "metadata"]);
const THREAD_KEYS = new Set([
  "id",
  "externalId",
  "parentThreadId",
]);
const ORIGIN_KEYS = new Set(["type", "id"]);

function dataObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol properties.`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${label} cannot declare '${key}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`${label}.${key} cannot be undefined.`);
    }
  }
}

function canonicalObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`${label}.${key} cannot be undefined.`);
    }
  }
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value.trim();
}

function exactContentText(
  value: unknown,
  label: string,
  required = false,
): void {
  if (value === undefined && !required) return;
  if (
    typeof value !== "string" || (required && !value.trim()) ||
    (required && value !== value.trim())
  ) {
    throw new TypeError(
      `${label} must be ${required ? "a non-empty" : "a"} string.`,
    );
  }
}

function validateContentFields(raw: Record<string, unknown>): void {
  for (const key of ["name", "alt", "language"] as const) {
    exactContentText(raw[key], `Goal content ${key}`);
  }
  if (raw.role !== undefined) {
    exactContentText(raw.role, "Goal content role", true);
  }
  if (raw.mediaType !== undefined) {
    exactContentText(raw.mediaType, "Goal content mediaType", true);
  }
  if (
    raw.disposition !== undefined && raw.disposition !== "inline" &&
    raw.disposition !== "attachment"
  ) throw new TypeError("Goal content disposition is invalid.");
  if (raw.metadata !== undefined) {
    canonicalObject(raw.metadata, "Goal content metadata");
    cloneGoalJson(raw.metadata as never, "Goal content metadata");
  }
  if (raw.origin !== undefined) {
    dataObject(raw.origin, ORIGIN_KEYS, "Goal content origin");
    const origin = raw.origin;
    exactContentText(origin.type, "Goal content origin type", true);
    exactContentText(origin.id, "Goal content origin id", true);
  }
}

function jsonSafePart(value: ContentInput): GoalContentInput {
  if (typeof value === "string") return value;
  canonicalObject(value, "Goal content part");
  const raw = value as Record<string, unknown>;
  const allowed = Object.hasOwn(raw, "assetId")
    ? CONTENT_REF_KEYS
    : raw.type === "text"
    ? CONTENT_TEXT_KEYS
    : raw.type === "json"
    ? CONTENT_JSON_KEYS
    : ["image", "audio", "video", "file"].includes(String(raw.type))
    ? CONTENT_MEDIA_KEYS
    : null;
  if (!allowed) throw new TypeError("Goal content part has an invalid shape.");
  dataObject(value, allowed, "Goal content part");
  validateContentFields(raw);
  if (allowed === CONTENT_REF_KEYS) {
    for (const key of ["assetId", "kind", "role", "mediaType"]) {
      exactContentText(raw[key], `Goal content ref ${key}`, true);
    }
    if (
      ![
        "text",
        "json",
        "image",
        "audio",
        "video",
        "file",
      ].includes(String(raw.kind))
    ) {
      throw new TypeError("Goal content ref kind is invalid.");
    }
  } else if (allowed === CONTENT_TEXT_KEYS) {
    if (typeof raw.text !== "string") {
      throw new TypeError("Goal text content requires text.");
    }
  } else if (allowed === CONTENT_JSON_KEYS) {
    if (!Object.hasOwn(raw, "value")) {
      throw new TypeError("Goal JSON content requires value.");
    }
  } else {
    if (!(raw.bytes instanceof Uint8Array)) {
      throw new TypeError("Goal binary content requires bytes and mediaType.");
    }
    exactContentText(raw.mediaType, "Goal media type", true);
  }
  const part = value as Record<string, unknown>;
  const bytes = part.bytes;
  if (bytes !== undefined) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Goal binary content bytes must be Uint8Array.");
    }
    if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype) {
      throw new TypeError(
        "Goal binary content bytes must be a plain Uint8Array.",
      );
    }
  }
  const serializable = Object.fromEntries(
    Object.entries(part).filter(([key]) => key !== "bytes"),
  );
  const copy = cloneGoalJson(
    serializable as never,
    "Goal content part",
  ) as Record<string, unknown>;
  return Object.freeze({
    ...copy,
    ...(bytes ? { dataBase64: bytesToBase64(bytes) } : {}),
  }) as GoalContentInput;
}

function jsonSafeContent(
  value: ContentInput | readonly ContentInput[],
): GoalContentInput | readonly GoalContentInput[] {
  if (!Array.isArray(value)) return jsonSafePart(value as ContentInput);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Goal content must be a plain array.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(value).length !== value.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length)
    )
  ) {
    throw new TypeError(
      "Goal content must be a dense array without extra properties.",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Goal content[${index}] must be a data property.`);
    }
  }
  const result: GoalContentInput[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(jsonSafePart(descriptors[String(index)].value as ContentInput));
  }
  return Object.freeze(result);
}

/** Typed start ingress. Behavior selection is only the Goal Resource alias. */
export function startGoal(
  input: GoalStartRequest,
): GoalStartInputEnvelope {
  dataObject(input, START_KEYS, "Goal start request");
  const goalAlias = optionalText(input.goal, "Goal Resource alias");
  if (!goalAlias) throw new TypeError("Goal Resource alias is required.");
  dataObject(input.sender, SENDER_KEYS, "Goal sender");
  const senderId = optionalText(input.sender.id, "Goal sender ID");
  const senderExternalId = optionalText(
    input.sender.externalId,
    "Goal sender external ID",
  );
  const senderName = optionalText(input.sender.name, "Goal sender name");
  const senderEmail = optionalText(input.sender.email, "Goal sender email");
  if (!senderId && !senderExternalId) {
    throw new TypeError("Goal sender requires id or externalId.");
  }
  let senderMetadata: GoalStartInput["sender"]["metadata"];
  if (input.sender.metadata !== undefined) {
    canonicalObject(input.sender.metadata, "Goal sender metadata");
    senderMetadata = cloneGoalJson(
      input.sender.metadata,
      "Goal sender metadata",
    );
  }
  let thread: GoalStartInput["thread"];
  if (typeof input.thread === "string") {
    thread = optionalText(input.thread, "Goal thread reference");
  } else if (input.thread !== undefined) {
    dataObject(input.thread, THREAD_KEYS, "Goal thread");
    const id = optionalText(input.thread.id, "Goal thread ID");
    const externalId = optionalText(
      input.thread.externalId,
      "Goal thread external ID",
    );
    const parentThreadId = optionalText(
      input.thread.parentThreadId,
      "Goal parent thread ID",
    );
    thread = Object.freeze({
      ...(id ? { id } : {}),
      ...(externalId ? { externalId } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
    });
  }
  let metadata: GoalStartInput["metadata"];
  if (input.metadata !== undefined) {
    canonicalObject(input.metadata, "Goal metadata");
    metadata = cloneGoalJson(input.metadata, "Goal metadata");
  }
  const payload: GoalStartInput = Object.freeze({
    goal: goalAlias,
    content: jsonSafeContent(input.content),
    sender: Object.freeze({
      ...(senderId ? { id: senderId } : {}),
      ...(senderExternalId ? { externalId: senderExternalId } : {}),
      ...(senderName ? { name: senderName } : {}),
      ...(senderEmail ? { email: senderEmail } : {}),
      ...(senderMetadata ? { metadata: senderMetadata } : {}),
    }),
    ...(thread ? { thread } : {}),
    ...(input.id === undefined
      ? {}
      : { id: optionalText(input.id, "Goal ID") }),
    ...(metadata ? { metadata } : {}),
  });
  return Object.freeze({
    type: GOAL_START_INPUT_EVENT,
    payload,
    ...(optionalText(input.namespace, "Goal namespace")
      ? { namespace: optionalText(input.namespace, "Goal namespace") }
      : {}),
    ...(optionalText(input.databaseSchema, "Goal database schema")
      ? {
        databaseSchema: optionalText(
          input.databaseSchema,
          "Goal database schema",
        ),
      }
      : {}),
    ...(optionalText(input.correlationId, "Goal correlation ID")
      ? {
        correlationId: optionalText(input.correlationId, "Goal correlation ID"),
      }
      : {}),
    ...(optionalText(input.causationId, "Goal causation ID")
      ? { causationId: optionalText(input.causationId, "Goal causation ID") }
      : {}),
    ...(optionalText(input.deduplicationId, "Goal deduplication ID")
      ? {
        deduplicationId: optionalText(
          input.deduplicationId,
          "Goal deduplication ID",
        ),
      }
      : {}),
  });
}

/** Typed durable cancellation ingress. */
export function cancelGoal(input: GoalCancelRequest): GoalCancelInputEnvelope {
  dataObject(input, CANCEL_KEYS, "Goal cancel request");
  const goalId = optionalText(input.goalId, "Goal ID");
  if (!goalId) throw new TypeError("Goal ID is required.");
  const payload: GoalCancelInput = Object.freeze({
    goalId,
    ...(input.reason === undefined
      ? {}
      : { reason: optionalText(input.reason, "Goal cancellation reason") }),
  });
  return Object.freeze({
    type: GOAL_CANCEL_INPUT_EVENT,
    payload,
    ...(optionalText(input.namespace, "Goal namespace")
      ? { namespace: optionalText(input.namespace, "Goal namespace") }
      : {}),
    ...(optionalText(input.databaseSchema, "Goal database schema")
      ? {
        databaseSchema: optionalText(
          input.databaseSchema,
          "Goal database schema",
        ),
      }
      : {}),
    ...(optionalText(input.correlationId, "Goal correlation ID")
      ? {
        correlationId: optionalText(input.correlationId, "Goal correlation ID"),
      }
      : {}),
    ...(optionalText(input.causationId, "Goal causation ID")
      ? { causationId: optionalText(input.causationId, "Goal causation ID") }
      : {}),
    ...(optionalText(input.deduplicationId, "Goal deduplication ID")
      ? {
        deduplicationId: optionalText(
          input.deduplicationId,
          "Goal deduplication ID",
        ),
      }
      : {}),
  });
}

export const goals: GoalInputHelpers = Object.freeze({
  start: startGoal,
  cancel: cancelGoal,
});
