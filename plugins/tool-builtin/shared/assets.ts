/** Shared asset-reference operations for built-in asset Tools.
 *
 * @module
 */

import {
  assetIdFromRef,
  type ContentRef,
  formatAssetRef,
} from "@copilotz/copilotz/content";
import { requiredText } from "./input.ts";

export function assetIdFromInput(
  namespace: string,
  input: Readonly<{ id?: unknown; assetId?: unknown; ref?: unknown }>,
): string {
  const direct = typeof input.assetId === "string"
    ? input.assetId
    : typeof input.id === "string"
    ? input.id
    : undefined;
  return assetIdFromRef(
    namespace,
    direct ?? requiredText(input.ref, "Asset ref"),
  );
}

export function assetKind(
  mediaType: string,
): "image" | "audio" | "video" | "text" | "json" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType.startsWith("text/")) return "text";
  return "file";
}

export { formatAssetRef };
export type { ContentRef };
