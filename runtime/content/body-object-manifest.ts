/** Bounded immutable-part metadata for the single object BodyStore. */
import {
  BODY_APPEND_MAX_BYTES,
  bodyIdentifier,
  bodyInteger,
  type BodyPart,
  type StoredBody,
} from "./body-store-operations.ts";
import { createContentError } from "./errors.ts";
export const BODY_MANIFEST_DECODE_BYTES = 4 * 1024 * 1024;
export const BODY_MANIFEST_MAX_PARTS = 8192;
export type BodyObjectLimits = Readonly<
  { maxManifestBytes: number; maxParts: number }
>;
export function bodyObjectLimits(
  input: Partial<BodyObjectLimits> = {},
): BodyObjectLimits {
  const maxManifestBytes = input.maxManifestBytes ?? 1024 * 1024,
    maxParts = input.maxParts ?? 4096;
  if (
    !Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1 ||
    maxManifestBytes > BODY_MANIFEST_DECODE_BYTES - 1024 ||
    !Number.isSafeInteger(maxParts) || maxParts < 1 ||
    maxParts > BODY_MANIFEST_MAX_PARTS
  ) throw new TypeError("Invalid body object growth limits.");
  return { maxManifestBytes, maxParts };
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export function encodeBodyObjectManifest(body: StoredBody): Uint8Array {
  return encoder.encode(JSON.stringify(body));
}
export function checkBodyObjectGrowth(
  body: StoredBody,
  limits: BodyObjectLimits,
): Uint8Array {
  const bytes = encodeBodyObjectManifest(body);
  if (
    body.parts.length > limits.maxParts ||
    bytes.length > limits.maxManifestBytes
  ) {
    throw createContentError(
      "content_invalid",
      "Body object growth limit exceeded.",
    );
  }
  return bytes;
}
function invalid(): never {
  throw createContentError("asset_corrupted", "Invalid body object manifest.");
}
function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (
    actual.length !== fields.length ||
    actual.some((key) => !fields.includes(key))
  ) invalid();
  return value as Record<string, unknown>;
}
export function decodeBodyObjectManifest(
  bytes: Uint8Array,
  expectedBodyId?: string,
): StoredBody {
  if (bytes.length > BODY_MANIFEST_DECODE_BYTES) invalid();
  try {
    const raw = record(JSON.parse(decoder.decode(bytes)), [
      "bodyId",
      "mediaType",
      "reservationId",
      "generation",
      "fencedFrom",
      "state",
      "byteLength",
      "digest",
      "revision",
      "nonce",
      "updatedAt",
      "parts",
    ]);
    const bodyId = bodyIdentifier(raw.bodyId),
      mediaType = bodyIdentifier(raw.mediaType),
      reservationId = bodyIdentifier(raw.reservationId),
      generation = bodyInteger(raw.generation, 1),
      byteLength = bodyInteger(raw.byteLength),
      revision = bodyInteger(raw.revision, 1),
      nonce = bodyIdentifier(raw.nonce);
    if (expectedBodyId !== undefined && bodyId !== expectedBodyId) invalid();
    if (
      !["open", "ready", "incomplete", "aborted"].includes(
        raw.state as string,
      ) || !Array.isArray(raw.parts) ||
      raw.parts.length > BODY_MANIFEST_MAX_PARTS ||
      typeof raw.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    ) invalid();
    if (
      raw.fencedFrom !== null &&
      (bodyInteger(raw.fencedFrom, 1) !== generation - 1)
    ) invalid();
    if (raw.state === "ready" || raw.state === "incomplete") {
      if (
        typeof raw.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(raw.digest)
      ) invalid();
    } else if (raw.digest !== null) invalid();
    let offset = 0;
    const seen = new Set<string>();
    const parts = raw.parts.map((value): BodyPart => {
      const part = record(value, ["appendId", "offset", "length", "digest"]),
        appendId = bodyIdentifier(part.appendId),
        length = bodyInteger(part.length, 1, BODY_APPEND_MAX_BYTES);
      if (
        bodyInteger(part.offset) !== offset || seen.has(appendId) ||
        typeof part.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(part.digest)
      ) invalid();
      seen.add(appendId);
      const start = offset;
      offset = bodyInteger(offset + length);
      return Object.freeze({
        appendId,
        offset: start,
        length,
        digest: part.digest as `sha256:${string}`,
      });
    });
    if (
      (raw.state === "incomplete" ||
          raw.state === "ready" && raw.fencedFrom !== null
        ? offset < byteLength
        : offset !== byteLength)
    ) invalid();
    return Object.freeze({
      bodyId,
      mediaType,
      reservationId,
      generation,
      fencedFrom: raw.fencedFrom as number | null,
      state: raw.state as StoredBody["state"],
      byteLength,
      digest: raw.digest as StoredBody["digest"],
      revision,
      nonce,
      updatedAt: raw.updatedAt,
      parts: Object.freeze(parts),
    });
  } catch {
    invalid();
  }
}
