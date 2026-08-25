/**
 * Builds credential-safe durable ingress envelopes for channel adapters.
 *
 * @module
 */

import type {
  ChannelIngressEnvelope,
  ChannelIngressEnvelopeOptions,
  ChannelIngressOccurrence,
  ChannelJsonObject,
  ChannelJsonValue,
} from "../../internal/contracts.ts";
import { CHANNEL_INGRESS_INPUT_EVENT } from "../../internal/contracts.ts";

const CREDENTIAL_KEYS = new Set([
  "authorization",
  "accesstoken",
  "bottoken",
  "apikey",
  "apisecret",
  "clientsecret",
  "privatekey",
  "password",
  "webhooksecret",
  "webhookverifytoken",
  "interactiontoken",
]);

const OCCURRENCE_KEYS = new Set(["id", "input"]);
const ENVELOPE_OPTION_KEYS = new Set([
  "namespace",
  "databaseSchema",
  "correlationId",
  "causationId",
  "deduplicationId",
  "metadata",
]);

function occurrenceIdentity(channelId: string, occurrenceId: string): string {
  return `channel:${
    JSON.stringify([
      "copilotz.channels.occurrence.v1",
      channelId,
      occurrenceId,
    ])
  }`;
}

function credentialKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function dataObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} cannot declare '${String(key)}'.`);
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
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/**
 * Copies one strict JSON value while rejecting credentials, accessors, custom
 * prototypes, sparse arrays, cycles, undefined, and non-finite numbers.
 */
export function cloneChannelJson(
  value: unknown,
  label = "Channel value",
  ancestors = new WeakSet<object>(),
): ChannelJsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must contain finite numbers.`);
    }
    return value;
  }
  if (!value || typeof value !== "object" || value instanceof Uint8Array) {
    throw new TypeError(`${label} must be strict JSON/base64 data.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} cannot contain cycles.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} must contain exact JSON arrays.`);
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
        throw new TypeError(`${label} must be a dense JSON array.`);
      }
      return Object.freeze(value.map((_item, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${label}[${index}] must be a data property.`);
        }
        return cloneChannelJson(
          descriptor.value,
          `${label}[${index}]`,
          ancestors,
        );
      }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain plain JSON objects.`);
    }
    const result: Record<string, ChannelJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${label} cannot contain symbol properties.`);
      }
      if (CREDENTIAL_KEYS.has(credentialKey(key))) {
        throw new TypeError(
          `${label} cannot persist credential field '${key}'.`,
        );
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
      result[key] = cloneChannelJson(
        descriptor.value,
        `${label}.${key}`,
        ancestors,
      );
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function jsonObject(value: unknown, label: string): ChannelJsonObject {
  const cloned = cloneChannelJson(value, label);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return cloned as ChannelJsonObject;
}

/**
 * Encodes an authenticated provider occurrence. No content preparation or
 * Asset materialization occurs before this Event is accepted durably.
 */
export function channelIngress(
  channelAlias: string,
  occurrence: ChannelIngressOccurrence,
  options: ChannelIngressEnvelopeOptions = {},
): ChannelIngressEnvelope {
  const channelId = requiredText(channelAlias, "Channel alias");
  const occurrenceSnapshot = dataObject(
    occurrence,
    OCCURRENCE_KEYS,
    "Channel occurrence",
  );
  const optionsSnapshot = dataObject(
    options,
    ENVELOPE_OPTION_KEYS,
    "Channel envelope options",
  );
  const id = requiredText(occurrenceSnapshot.id, "Channel occurrence ID");
  const identity = occurrenceIdentity(channelId, id);
  const namespace = optionalText(
    optionsSnapshot.namespace,
    "Channel namespace",
  );
  const databaseSchema = optionalText(
    optionsSnapshot.databaseSchema,
    "Channel database schema",
  );
  const correlationId = optionalText(
    optionsSnapshot.correlationId,
    "Channel correlation ID",
  ) ?? identity;
  const causationId = optionalText(
    optionsSnapshot.causationId,
    "Channel causation ID",
  );
  const deduplicationId = optionalText(
    optionsSnapshot.deduplicationId,
    "Channel deduplication ID",
  ) ?? identity;
  const metadata = optionsSnapshot.metadata === undefined
    ? undefined
    : jsonObject(optionsSnapshot.metadata, "Channel Event metadata");
  return Object.freeze({
    type: CHANNEL_INGRESS_INPUT_EVENT,
    payload: Object.freeze({
      channelId,
      id,
      input: cloneChannelJson(
        occurrenceSnapshot.input,
        "Channel occurrence input",
      ),
    }),
    ...(namespace ? { namespace } : {}),
    ...(databaseSchema ? { databaseSchema } : {}),
    correlationId,
    ...(causationId ? { causationId } : {}),
    deduplicationId,
    ...(metadata ? { metadata } : {}),
    visibility: Object.freeze({ kind: "internal" as const }),
  });
}
