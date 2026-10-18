import type { ContentKind } from "../content/types.ts";

/** Shared normalization for stream admission and final descriptors. */
export function streamContentKind(mediaType: string): ContentKind {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "application/json" || normalized.endsWith("+json")) {
    return "json";
  }
  if (normalized.startsWith("text/")) return "text";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "file";
}
