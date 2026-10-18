/** Private F9 byte-storage contract. No leases, catalog decisions or successor writers. */
import { createContentError } from "./errors.ts";
import { createHash } from "node:crypto";

export const OWNER_PHYSICAL_BODY_FORMAT = "owner-physical-v1" as const;
export const PHYSICAL_APPEND_MAX_BYTES = 1024 * 1024;
/** Callers page larger reads; one private request never allocates an entire body. */
export const PHYSICAL_READ_MAX_BYTES = 1024 * 1024;
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
  /** Original requested offset, including exact append replay. */
  startOffset: number;
  /** Current physical head; an older replay can include later tentative bytes.
   * A caller acknowledges only its original offset plus requested byte length. */
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
/** Capture bounded append data before any asynchronous owner admission. */
export function capturePhysicalAppendData(
  input: unknown,
): Omit<PhysicalAppend, "writer"> {
  const value = data(input, ["expectedOffset", "appendId", "bytes"]);
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
    expectedOffset,
    appendId: physicalIdentifier(value.appendId),
    bytes,
  });
}
export function capturePhysicalAppend(input: unknown): PhysicalAppend {
  const value = data(input, ["writer", "expectedOffset", "appendId", "bytes"]);
  const append = capturePhysicalAppendData({
    expectedOffset: value.expectedOffset,
    appendId: value.appendId,
    bytes: value.bytes,
  });
  return Object.freeze({
    writer: capturePhysicalIdentity(value.writer),
    ...append,
  });
}
export function capturePhysicalRange(input: unknown): PhysicalRange {
  const value = data(input, ["bodyId", "offset", "end"]);
  const offset = integer(value.offset), end = integer(value.end);
  if (end < offset || end - offset > PHYSICAL_READ_MAX_BYTES) invalid();
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

/** Owner-side integrity check over one catalog-accepted prefix. Physical stores
 * never decide the accepted length, and no whole-body buffer is allocated. */
export async function digestPhysicalPrefix(
  store: Pick<PhysicalBodyStore, "head" | "readRange">,
  original: PhysicalWriterIdentity,
  length: number,
  state: "open" | "fenced",
  signal?: AbortSignal,
): Promise<Readonly<{ head: PhysicalBodyHead; digest: `sha256:${string}` }>> {
  if (state !== "open" && state !== "fenced") invalid();
  const writer = capturePhysicalIdentity(original), accepted = integer(length);
  const readHead = store.head.bind(store),
    readRange = store.readRange.bind(store);
  const cancelled = () => {
    if (signal?.aborted) throw signal.reason;
  };
  const inspect = (raw: unknown): PhysicalBodyHead => {
    if (raw === null) {
      throw createContentError(
        "asset_storage_unavailable",
        "Physical prefix body is missing.",
      );
    }
    const value = data(raw, [
      "bodyId",
      "mediaType",
      "reservationId",
      "generation",
      "format",
      "state",
      "byteLength",
      "versionToken",
    ]);
    if (
      value.format !== OWNER_PHYSICAL_BODY_FORMAT || value.state !== state ||
      value.bodyId !== writer.bodyId || value.mediaType !== writer.mediaType ||
      value.reservationId !== writer.reservationId ||
      value.generation !== writer.generation + (state === "fenced" ? 1 : 0) ||
      integer(value.byteLength) < accepted
    ) {
      throw createContentError(
        "asset_storage_unavailable",
        "Physical prefix identity or length is unavailable.",
      );
    }
    if (
      typeof value.versionToken !== "string" || !value.versionToken ||
      value.versionToken.length > 4096
    ) invalid();
    return Object.freeze(value as unknown as PhysicalBodyHead);
  };
  cancelled();
  const before = inspect(await readHead(writer.bodyId));
  cancelled();
  const hash = createHash("sha256");
  for (let offset = 0; offset < accepted;) {
    const end = Math.min(accepted, offset + PHYSICAL_READ_MAX_BYTES);
    cancelled();
    const bytes = await readRange({ bodyId: writer.bodyId, offset, end });
    cancelled();
    if (
      !(bytes instanceof Uint8Array) ||
      typedArrayLength.call(bytes) !== end - offset
    ) {
      throw createContentError(
        "asset_storage_unavailable",
        "Physical prefix read is incomplete.",
      );
    }
    hash.update(bytes);
    offset = end;
  }
  const after = inspect(await readHead(writer.bodyId));
  cancelled();
  if (
    after.versionToken !== before.versionToken ||
    after.byteLength !== before.byteLength
  ) {
    throw createContentError(
      "asset_conflict",
      "Physical prefix changed during verification.",
    );
  }
  return Object.freeze({
    head: after,
    digest: `sha256:${hash.digest("hex")}` as const,
  });
}
