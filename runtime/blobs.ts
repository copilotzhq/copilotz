/**
 * Large values live once, as blobs named by the hash of their content. A
 * document or event holds a small reference in their place:
 * `{ $blob: "sha256-…", size, type }`. The owner moves large values out on
 * write and back in on read, so plugin code never sees a reference, and the
 * same content written twice (a document and its event, or two equal tool
 * results) is stored once.
 */

export type BlobRef = { $blob: string; size: number; type: string };

/**
 * Where blobs live when not in the store itself (a directory, a bucket).
 * Content-addressed: putting an id that exists is a no-op.
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

export const isBlobRef = (value: unknown): value is BlobRef =>
  typeof value === "object" && value !== null && typeof (value as BlobRef).$blob === "string";

export async function blobId(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return "sha256-" + Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `value` holds a string that may exceed the threshold (cheap, synchronous). */
function large(value: unknown, threshold: number): boolean {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so shorter strings always fit.
  if (typeof value === "string") return value.length * 3 > threshold;
  if (value === null || typeof value !== "object" || isBlobRef(value)) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some((v) => large(v, threshold));
}

function holdsRef(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isBlobRef(value)) return true;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsRef);
}

/** Replaces strings over the threshold with blob references, storing each with `put`. */
export async function offload<T>(
  value: T,
  put: (blob: { id: string; data: Uint8Array; type: string }) => Promise<void>,
  threshold = BLOB_THRESHOLD,
): Promise<T> {
  if (!large(value, threshold)) return value;
  if (typeof value === "string") {
    const data = encoder.encode(value);
    if (data.length <= threshold) return value;
    const id = await blobId(data);
    await put({ id, data, type: TEXT });
    return { $blob: id, size: data.length, type: TEXT } satisfies BlobRef as T;
  }
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<string, unknown>;
  for (const [key, item] of Object.entries(copy)) copy[key] = await offload(item, put, threshold);
  return copy as T;
}

/** Replaces blob references with their content. */
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
