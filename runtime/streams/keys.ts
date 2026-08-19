import type { ContentKind } from "../content/index.ts";

function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}

/** Deterministic body-store key for one stream's reserved asset identity. */
export function streamBodyKey(
  input: Readonly<{ namespace: string; assetId: string }>,
): string {
  const namespace = input.namespace.trim();
  const assetId = input.assetId.trim();
  if (!namespace || !assetId) {
    throw new TypeError("Stream body key requires namespace and assetId.");
  }
  return ["streams", cleanSegment(namespace), cleanSegment(assetId)].join("/");
}

export function contentKindFromMediaType(mediaType: string): ContentKind {
  const type = mediaType.trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type.startsWith("text/")) return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return "file";
}

export function contentRoleForLane(lane: string): string {
  switch (lane.trim()) {
    case "reasoning":
      return "reasoning";
    case "transcript":
      return "transcript";
    case "tool_call":
      return "tool.arguments";
    case "tool_output":
      return "tool.output";
    default:
      return "body";
  }
}
