import type { ContentRef, PendingContentRef } from "./types.ts";
import { assertJsonValue } from "../json.ts";

/** Canonical persisted content reference; resolved values are not stored here. */
export const contentRefSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assetId: { type: "string" },
    kind: {
      type: "string",
      enum: ["text", "json", "image", "audio", "video", "file"],
    },
    role: { type: "string" },
    mediaType: { type: "string" },
    name: { type: "string" },
    alt: { type: "string" },
    language: { type: "string" },
    disposition: { type: "string", enum: ["inline", "attachment"] },
    metadata: { type: "object" },
  },
  required: ["assetId", "kind", "role", "mediaType"],
} as const;

export const contentSequenceSchema = {
  type: "array",
  items: contentRefSchema,
} as const;

/** Checks reference metadata; additional resolved-value properties are allowed. */
export function isContentRef(value: unknown): value is ContentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (!contentRefSchema.required.every((key) => typeof ref[key] === "string")) {
    return false;
  }
  if (
    !(contentRefSchema.properties.kind.enum as readonly unknown[]).includes(
      ref.kind,
    )
  ) return false;
  for (const key of ["name", "alt", "language"] as const) {
    if (ref[key] !== undefined && typeof ref[key] !== "string") return false;
  }
  if (
    ref.disposition !== undefined &&
    !(contentRefSchema.properties.disposition.enum as readonly unknown[])
      .includes(ref.disposition)
  ) return false;
  return ref.metadata === undefined || (
    ref.metadata !== null && typeof ref.metadata === "object" &&
    !Array.isArray(ref.metadata)
  );
}

/** Closed generated-output pointer. It carries no Asset or storage authority. */
export const pendingContentRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "pendingRef", "mediaType", "byteLength", "digest"],
  properties: {
    type: { const: "content.pending" },
    pendingRef: { type: "string", minLength: 1, maxLength: 1024 },
    mediaType: { type: "string", minLength: 1, maxLength: 1024 },
    byteLength: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
  },
} as const;
export const generatedContentSequenceSchema = {
  type: "array",
  items: { anyOf: [contentRefSchema, pendingContentRefSchema] },
} as const;

export function capturePendingContentRef(value: unknown): PendingContentRef {
  const invalid = (): never => {
    throw new TypeError("Invalid pending content reference.");
  };
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = pendingContentRefSchema.required;
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  ) invalid();
  const ref: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
    ref[key] = descriptor.value;
  }
  assertJsonValue(ref, {
    label: "Pending content reference",
    maxDepth: 1,
    maxNodes: 6,
    rejectNegativeZero: true,
  });
  if (
    ref.type !== "content.pending" ||
    ![ref.pendingRef, ref.mediaType].every((v) =>
      typeof v === "string" && v.length > 0 && v.length <= 1024 &&
      v === v.trim()
    ) ||
    typeof ref.byteLength !== "number" ||
    !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 ||
    typeof ref.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref.digest)
  ) invalid();
  return Object.freeze(ref) as PendingContentRef;
}
export function isPendingContentRef(
  value: unknown,
): value is PendingContentRef {
  try {
    capturePendingContentRef(value);
    return true;
  } catch {
    return false;
  }
}
