function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

/** Formats one tenant-scoped canonical asset reference. */
export function formatAssetRef(namespace: string, assetId: string): string {
  return "asset://" +
    encodeURIComponent(required(namespace, "Asset namespace")) + "/" +
    encodeURIComponent(required(assetId, "Asset ID"));
}

/** Resolves a raw asset ID or canonical asset:// reference in one namespace. */
export function assetIdFromRef(namespace: string, refOrId: string): string {
  const activeNamespace = required(namespace, "Asset namespace");
  const normalized = required(refOrId, "Asset ID or ref");
  if (!normalized.startsWith("asset://")) return normalized;

  let segments: string[];
  try {
    segments = normalized.slice("asset://".length).split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch (cause) {
    throw new TypeError("Asset ref contains invalid URL encoding.", { cause });
  }

  // Preserve the historical asset://<id> shorthand while preferring the
  // namespace-qualified canonical form emitted by formatAssetRef().
  if (segments.length === 1) return required(segments[0], "Asset ID");
  if (segments.length !== 2 || segments[0] !== activeNamespace) {
    throw new Error("Asset ref does not belong to the active namespace.");
  }
  return required(segments[1], "Asset ID");
}
