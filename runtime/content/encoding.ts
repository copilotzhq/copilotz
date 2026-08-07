/** Runtime-neutral base64 encoding over the Web platform API. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("This runtime does not provide the Web btoa API.");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

/** Runtime-neutral base64 decoding over the Web platform API. */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("This runtime does not provide the Web atob API.");
  }
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function toDataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}

export function parseDataUrl(
  value: string,
): Readonly<{ mediaType: string; bytes: Uint8Array }> | null {
  if (!value.startsWith("data:")) return null;
  const separator = value.indexOf(",");
  if (separator < 0) return null;
  const metadata = value.slice(5, separator);
  const encoded = value.slice(separator + 1);
  const segments = metadata.split(";");
  const mediaType = segments[0]?.trim() || "application/octet-stream";
  try {
    const bytes = segments.includes("base64")
      ? base64ToBytes(encoded)
      : new TextEncoder().encode(decodeURIComponent(encoded));
    return Object.freeze({ mediaType, bytes });
  } catch {
    return null;
  }
}
