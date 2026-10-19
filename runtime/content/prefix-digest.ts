import { sha256 } from "@noble/hashes/sha256";
import type { BodyStore } from "./body-store.ts";
import { createContentError } from "./errors.ts";
const CONTENT_CHUNK_BYTES = 1024 * 1024;
/** Verify the catalog prefix without accepting tentative bytes. */
export async function digestCatalogPrefix(
  store: BodyStore,
  key: string,
  length: number,
  suffix?: Uint8Array,
): Promise<`sha256:${string}`> {
  if (!Number.isSafeInteger(length) || length < (suffix?.length ?? 0)) {
    throw new TypeError("Invalid prefix length.");
  }
  const hash = sha256.create();
  const storedLength = length - (suffix?.length ?? 0);
  for (let offset = 0; offset < storedLength;) {
    const end = Math.min(storedLength, offset + CONTENT_CHUNK_BYTES);
    const bytes = await store.readRange({ bodyId: key, offset, end });
    if (bytes.byteLength !== end - offset) {
      throw createContentError(
        "content_missing",
        "Catalog prefix is unavailable.",
      );
    }
    hash.update(bytes);
    offset = end;
  }
  if (suffix) hash.update(suffix);
  return `sha256:${
    Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
