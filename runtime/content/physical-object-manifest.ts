/** Private object format. Growth limits never prevent retained reads or fencing. */
import { createContentError } from "./errors.ts";
import {
  capturePhysicalIdentity,
  OWNER_PHYSICAL_BODY_FORMAT,
  PHYSICAL_APPEND_MAX_BYTES,
  physicalIdentifier,
  type PhysicalWriterIdentity,
} from "./physical-body-store.ts";

export const PHYSICAL_MANIFEST_DECODE_BYTES = 4 * 1024 * 1024;
export const PHYSICAL_MANIFEST_DECODE_PARTS = 8192;
export type PhysicalObjectPart = Readonly<{
  appendId: string;
  offset: number;
  length: number;
  digest: string;
}>;
export type PhysicalObjectManifest = Readonly<{
  format: typeof OWNER_PHYSICAL_BODY_FORMAT;
  scope: string;
  identity: PhysicalWriterIdentity;
  state: "open" | "fenced";
  byteLength: number;
  parts: readonly PhysicalObjectPart[];
}>;
export type PhysicalObjectGrowthLimits = Readonly<{
  maxManifestBytes: number;
  maxParts: number;
}>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function unavailable(): never {
  throw createContentError(
    "asset_storage_unavailable",
    "Invalid physical object manifest.",
  );
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    unavailable();
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length || actual.some((key) => !keys.includes(key))
  ) unavailable();
  return result;
}
function natural(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) unavailable();
  return value;
}
export function physicalObjectGrowthLimits(
  input: Partial<PhysicalObjectGrowthLimits> = {},
): PhysicalObjectGrowthLimits {
  const maxManifestBytes = input.maxManifestBytes ?? 1024 * 1024;
  const maxParts = input.maxParts ?? 4096;
  // Fencing grows the state string by two bytes without changing any parts.
  if (
    !Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1 ||
    maxManifestBytes > PHYSICAL_MANIFEST_DECODE_BYTES - 2 ||
    !Number.isSafeInteger(maxParts) || maxParts < 1 ||
    maxParts > PHYSICAL_MANIFEST_DECODE_PARTS
  ) {
    throw createContentError(
      "content_invalid",
      "Invalid physical object growth limits.",
    );
  }
  return Object.freeze({ maxManifestBytes, maxParts });
}
export function encodePhysicalObjectManifest(
  manifest: PhysicalObjectManifest,
): Uint8Array {
  return encoder.encode(JSON.stringify(manifest));
}
export function checkPhysicalObjectGrowth(
  manifest: PhysicalObjectManifest,
  limits: PhysicalObjectGrowthLimits,
): Uint8Array {
  const encoded = encodePhysicalObjectManifest(manifest);
  if (
    manifest.parts.length > limits.maxParts ||
    encoded.byteLength > limits.maxManifestBytes
  ) {
    throw createContentError(
      "content_invalid",
      "Physical object growth limit exceeded.",
    );
  }
  return encoded;
}
export function decodePhysicalObjectManifest(
  bytes: Uint8Array,
  scope: string,
  bodyId: string,
): PhysicalObjectManifest {
  if (bytes.byteLength > PHYSICAL_MANIFEST_DECODE_BYTES) unavailable();
  try {
    const value = record(JSON.parse(decoder.decode(bytes)), [
      "format",
      "scope",
      "identity",
      "state",
      "byteLength",
      "parts",
    ]);
    if (
      value.format !== OWNER_PHYSICAL_BODY_FORMAT || value.scope !== scope ||
      (value.state !== "open" && value.state !== "fenced") ||
      !Array.isArray(value.parts) ||
      value.parts.length > PHYSICAL_MANIFEST_DECODE_PARTS
    ) unavailable();
    if (
      value.state === "open" &&
      bytes.byteLength > PHYSICAL_MANIFEST_DECODE_BYTES - 2
    ) unavailable();
    const identity = capturePhysicalIdentity(value.identity);
    if (identity.bodyId !== bodyId) unavailable();
    const byteLength = natural(value.byteLength);
    const seen = new Set<string>();
    let offset = 0;
    const parts = value.parts.map((raw): PhysicalObjectPart => {
      const part = record(raw, ["appendId", "offset", "length", "digest"]);
      const appendId = physicalIdentifier(part.appendId);
      const length = natural(part.length, 1, PHYSICAL_APPEND_MAX_BYTES);
      if (
        seen.has(appendId) || natural(part.offset) !== offset ||
        typeof part.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(part.digest)
      ) unavailable();
      seen.add(appendId);
      const start = offset;
      offset += length;
      if (!Number.isSafeInteger(offset)) unavailable();
      return Object.freeze({
        appendId,
        offset: start,
        length,
        digest: part.digest,
      });
    });
    if (offset !== byteLength) unavailable();
    const manifest = Object.freeze({
      format: OWNER_PHYSICAL_BODY_FORMAT,
      scope,
      identity,
      state: value.state,
      byteLength,
      parts: Object.freeze(parts),
    });
    if (
      manifest.state === "open" &&
      encodePhysicalObjectManifest(manifest).byteLength >
        PHYSICAL_MANIFEST_DECODE_BYTES - 2
    ) unavailable();
    return manifest;
  } catch {
    unavailable();
  }
}
