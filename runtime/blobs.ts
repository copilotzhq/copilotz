/**
 * Large values live once, as blobs named by the hash of their content. A
 * document or event holds a small reference in their place:
 * `{ $blob: "sha256-…", size, type }`. The owner moves large values out on
 * write and back in on read, so plugin code never sees a reference, and the
 * same content written twice (a document and its event, or two equal tool
 * results) is stored once.
 *
 * Only the owner makes references. What plugin code writes (documents,
 * updates, edges, events) and what Actions are called with may hold no
 * `$blob` key at all: one there is forged, and refused. On read, only an
 * exact reference is loaded (see `isBlobRef`); anything else is data.
 */
import { invalid } from "./errors.ts";

export type BlobRef = { $blob: string; size: number; type: string };

/**
 * Where blobs live when not in the store itself (a directory, a bucket).
 * Content-addressed: putting an id that exists is a no-op. An id is only ever
 * a blob's: refuse any other (`checkBlobId`) before it becomes a path or a name.
 */
export type Blobs = {
  put(blob: { id: string; data: Uint8Array; type?: string }): Promise<void>;
  get(id: string): Promise<{ data: Uint8Array; type?: string } | null>;
};

/** Strings larger than this many UTF-8 bytes become blobs (default 16 KiB). */
export const BLOB_THRESHOLD = 16 * 1024;

const TEXT = "text/plain; charset=utf-8";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A blob's id: `sha256-` and the hex of its content's hash. Never a path or a name. */
const ID = /^sha256-[0-9a-f]{64}$/;

export const isBlobId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

/** The id, when it is a blob's; else `invalid`. Stores check it before they look anything up. */
export function checkBlobId(id: unknown): string {
  if (isBlobId(id)) return id;
  throw invalid(`Not a blob id: ${JSON.stringify(String(id).slice(0, 80))}`);
}

/** Exactly what `offload` makes: these three keys, a blob id, a numeric size and a type. */
export const isBlobRef = (value: unknown): value is BlobRef => {
  // Most objects have no `$blob`: one look is all they cost.
  if (value === null || typeof value !== "object" || !isBlobId((value as BlobRef).$blob)) {
    return false;
  }
  const { size, type } = value as BlobRef;
  return typeof size === "number" && typeof type === "string" &&
    Object.keys(value).length === 3 && Object.hasOwn(value, "$blob") &&
    Object.hasOwn(value, "size") && Object.hasOwn(value, "type");
};

export async function blobId(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return "sha256-" + Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

const forged = () =>
  invalid("\"$blob\" is reserved for the runtime's blob references: data can't hold that key.");

/**
 * Whether `value` holds a string that may exceed the threshold (cheap, synchronous).
 * `foreign`: the value is plugin code's, so an object with a `$blob` key is
 * refused on the way. Every object gets that look: this walk stops early
 * only at a large string, and `offload` then walks each part of the value.
 */
function large(value: unknown, threshold: number, foreign: boolean): boolean {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so shorter strings always fit.
  if (typeof value === "string") return value.length * 3 > threshold;
  if (value === null || typeof value !== "object") return false;
  if (foreign) {
    if (Object.hasOwn(value, "$blob")) throw forged();
  } else if (isBlobRef(value)) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some((v) =>
    large(v, threshold, foreign)
  );
}

/** Refuses (`invalid`) a value of plugin code's that holds an object with a `$blob` key. */
export function refuseBlobKeys(value: unknown): void {
  // No string is over an infinite threshold: the walk looks at everything.
  large(value, Infinity, true);
}

function holdsRef(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isBlobRef(value)) return true;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsRef);
}

/**
 * Replaces strings over the threshold with blob references, storing each with `put`.
 * `foreign`: the value is plugin code's, and may hold no `$blob` key (see
 * `large`); otherwise it's the owner's, and its references stay as they are.
 */
export async function offload<T>(
  value: T,
  put: (blob: { id: string; data: Uint8Array; type: string }) => Promise<void>,
  threshold = BLOB_THRESHOLD,
  foreign = false,
): Promise<T> {
  if (!large(value, threshold, foreign)) return value;
  if (typeof value === "string") {
    const data = encoder.encode(value);
    if (data.length <= threshold) return value;
    const id = await blobId(data);
    await put({ id, data, type: TEXT });
    return { $blob: id, size: data.length, type: TEXT } satisfies BlobRef as T;
  }
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<string, unknown>;
  for (const [key, item] of Object.entries(copy)) {
    copy[key] = await offload(item, put, threshold, foreign);
  }
  return copy as T;
}

/** Replaces blob references with their content; one whose blob is gone fails (`missing_blob`). */
export async function hydrate<T>(
  value: T,
  get: (id: string) => Promise<{ data: Uint8Array } | null>,
): Promise<T> {
  if (!holdsRef(value)) return value;
  if (isBlobRef(value)) {
    const blob = await get(value.$blob);
    if (!blob) {
      throw Object.assign(new Error(`Missing blob ${value.$blob}`), { code: "missing_blob" });
    }
    return decoder.decode(blob.data) as T;
  }
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<string, unknown>;
  for (const [key, item] of Object.entries(copy)) copy[key] = await hydrate(item, get);
  return copy as T;
}
