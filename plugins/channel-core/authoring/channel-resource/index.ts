/**
 * Validates and freezes the data-only policy for a channel alias.
 *
 * @module
 */

import type {
  ChannelJsonObject,
  ChannelResource,
} from "../../internal/contracts.ts";
import { cloneChannelJson } from "../channel-ingress/index.ts";

const RESOURCE_KEYS = new Set([
  "egress",
  "defaultAgentAliases",
  "metadata",
]);

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

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function aliasArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError("Default Agent aliases must be an exact array.");
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
    throw new TypeError("Default Agent aliases must be a dense data array.");
  }
  const aliases: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Default Agent aliases[${index}] must be a data property.`,
      );
    }
    aliases.push(requiredText(descriptor.value, "Default Agent alias"));
  }
  return Object.freeze([...new Set(aliases)]);
}

/** Freezes data-only Channel policy; its map alias remains external. */
export function defineChannelResource(input: ChannelResource): ChannelResource {
  const snapshot = dataObject(input, RESOURCE_KEYS, "Channel Resource");
  if (
    snapshot.egress !== "external" &&
    snapshot.egress !== "request-observation"
  ) {
    throw new TypeError("Channel Resource has an invalid egress mode.");
  }
  const aliases = snapshot.defaultAgentAliases === undefined
    ? undefined
    : aliasArray(snapshot.defaultAgentAliases);
  const metadata = snapshot.metadata === undefined
    ? undefined
    : cloneChannelJson(
      snapshot.metadata,
      "Channel Resource metadata",
    ) as ChannelJsonObject;
  if (metadata && Array.isArray(metadata)) {
    throw new TypeError("Channel Resource metadata must be a JSON object.");
  }
  return Object.freeze({
    egress: snapshot.egress,
    ...(aliases?.length
      ? { defaultAgentAliases: Object.freeze([...new Set(aliases)]) }
      : {}),
    ...(metadata ? { metadata } : {}),
  });
}

export function isChannelResource(value: unknown): value is ChannelResource {
  try {
    defineChannelResource(value as ChannelResource);
    return true;
  } catch {
    return false;
  }
}
