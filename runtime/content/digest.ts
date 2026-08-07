import { createContentError } from "./errors.ts";

/** Computes the integrity digest used by canonical assets. */
export async function digestContent(
  bytes: Uint8Array,
): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) {
    throw createContentError(
      "content_invalid",
      "A Web Crypto SHA-256 implementation is required to publish content.",
    );
  }
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", input),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
