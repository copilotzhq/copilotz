/**
 * Shared utilities for channel handlers.
 *
 * @module
 */

/**
 * Extract plain text from a message content value.
 * Handles both `string` payloads and multimodal `Array<{ type, text }>` arrays.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function parseDataUrl(
  dataUrl: string,
): { bytes: Uint8Array; mimeType: string } | null {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return null;

  const mimeType = matches[1];
  const binaryString = atob(matches[2]);
  const buffer = new ArrayBuffer(binaryString.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return { bytes, mimeType };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Split a string into chunks of at most `maxLen` characters, preferring to
 * break at one of the given `breakpoints` characters.
 */
export function splitString(
  input: string,
  maxLen: number,
  breakpoints: string[],
): string[] {
  const result: string[] = [];
  let idx = 0;

  while (idx < input.length) {
    if (idx + maxLen >= input.length) {
      result.push(input.substring(idx));
      break;
    }

    const end = idx + maxLen;
    let found = false;
    for (let i = end; i > idx; i--) {
      if (breakpoints.includes(input[i])) {
        result.push(input.substring(idx, i));
        idx = i + 1;
        found = true;
        break;
      }
    }
    if (!found) {
      result.push(input.substring(idx, end));
      idx = end;
    }
  }

  return result;
}

/**
 * Verify an HMAC-SHA256 signature in the format `sha256=<hex>` against a raw
 * body and secret. Returns `true` when the signature is valid.
 */
export async function verifyHmacSha256(
  body: Uint8Array,
  secret: string,
  signatureHeader: string,
): Promise<boolean> {
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const receivedHash = signatureHeader.slice(expectedPrefix.length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bodyBuffer = (body.buffer as ArrayBuffer).slice(body.byteOffset, body.byteOffset + body.byteLength);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, bodyBuffer);
  const computedHash = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(receivedHash, computedHash);
}
