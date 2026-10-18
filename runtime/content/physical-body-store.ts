/** Private F9 byte-storage contract. No leases, catalog decisions or successor writers. */
import { createContentError } from "./errors.ts";

export const OWNER_PHYSICAL_BODY_FORMAT = "owner-physical-v1" as const;
export const PHYSICAL_APPEND_MAX_BYTES = 1024 * 1024;
export type PhysicalWriterIdentity = Readonly<{
  bodyId: string;
  mediaType: string;
  reservationId: string;
  generation: number;
}>;
export type PhysicalBodyHead =
  & PhysicalWriterIdentity
  & Readonly<{
    format: typeof OWNER_PHYSICAL_BODY_FORMAT;
    state: "open" | "fenced";
    byteLength: number;
    versionToken: string;
  }>;
export type PhysicalAppend = Readonly<{
  writer: PhysicalWriterIdentity;
  expectedOffset: number;
  appendId: string;
  bytes: Uint8Array;
}>;
export type PhysicalAppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
  versionToken: string;
}>;
export type PhysicalRange = Readonly<
  { bodyId: string; offset: number; end: number }
>;
export type PhysicalBodyStore = Readonly<{
  reserve(identity: PhysicalWriterIdentity): Promise<PhysicalBodyHead>;
  append(input: PhysicalAppend): Promise<PhysicalAppendResult>;
  /** Exact retryable fence, including a create-only tombstone for an absent key. */
  fence(identity: PhysicalWriterIdentity): Promise<PhysicalBodyHead>;
  head(bodyId: string): Promise<PhysicalBodyHead | null>;
  readRange(input: PhysicalRange): Promise<Uint8Array>;
}>;

function invalid(): never {
  throw createContentError(
    "content_invalid",
    "Invalid private physical body request.",
  );
}
function data(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  ) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
export function physicalIdentifier(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) invalid();
  return value;
}
function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) invalid();
  return value;
}
export function capturePhysicalIdentity(
  input: unknown,
): PhysicalWriterIdentity {
  const value = data(input, [
    "bodyId",
    "mediaType",
    "reservationId",
    "generation",
  ]);
  return Object.freeze({
    bodyId: physicalIdentifier(value.bodyId),
    mediaType: physicalIdentifier(value.mediaType),
    reservationId: physicalIdentifier(value.reservationId),
    generation: integer(value.generation, 1, Number.MAX_SAFE_INTEGER - 1),
  });
}
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
export function capturePhysicalAppend(input: unknown): PhysicalAppend {
  const value = data(input, ["writer", "expectedOffset", "appendId", "bytes"]);
  if (!(value.bytes instanceof Uint8Array)) invalid();
  const length = typedArrayLength.call(value.bytes) as number;
  // Producers normalize empty writes before allocating an append ID. The new
  // physical format never inherits the legacy adapters' different empty rules.
  if (
    !Number.isSafeInteger(length) || length < 1 ||
    length > PHYSICAL_APPEND_MAX_BYTES
  ) invalid();
  const bytes = new Uint8Array(value.bytes);
  const expectedOffset = integer(value.expectedOffset);
  if (!Number.isSafeInteger(expectedOffset + bytes.byteLength)) invalid();
  return Object.freeze({
    writer: capturePhysicalIdentity(value.writer),
    expectedOffset,
    appendId: physicalIdentifier(value.appendId),
    bytes,
  });
}
export function capturePhysicalRange(input: unknown): PhysicalRange {
  const value = data(input, ["bodyId", "offset", "end"]);
  const offset = integer(value.offset), end = integer(value.end);
  if (end < offset) invalid();
  return Object.freeze({
    bodyId: physicalIdentifier(value.bodyId),
    offset,
    end,
  });
}
export function samePhysicalWriter(
  a: PhysicalWriterIdentity,
  b: PhysicalWriterIdentity,
): boolean {
  return a.bodyId === b.bodyId && a.mediaType === b.mediaType &&
    a.reservationId === b.reservationId && a.generation === b.generation;
}
