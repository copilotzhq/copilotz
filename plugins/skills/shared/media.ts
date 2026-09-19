/** Returns whether a Skill file's declared media type is safe to decode as text. @module */

/**
 * Keep build-time packing and agent-facing reads on the same MIME policy.
 * Parameters such as `charset` are ignored; structured `+json`/`+xml` types
 * and common script types remain textual while images/PDFs stay binary.
 */
export function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/yaml" ||
    normalized === "application/xml" ||
    normalized === "image/svg+xml" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml") ||
    normalized.includes("javascript") ||
    normalized.includes("typescript");
}
