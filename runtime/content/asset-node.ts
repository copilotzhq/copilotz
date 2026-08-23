import type { AssetRecord } from "./types.ts";

/** Canonical JSON projection persisted in every runtime Asset node. */
export function assetNodeData(
  asset: AssetRecord,
  bodyId: string,
): Readonly<Record<string, unknown>> {
  const normalizedBodyId = bodyId.trim();
  if (!normalizedBodyId) {
    throw new TypeError("Asset bodyId must be non-empty.");
  }
  return Object.freeze({
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    digest: asset.digest,
    state: asset.state,
    bodyId: normalizedBodyId,
    location: structuredClone(asset.location),
    ...(asset.readyAt ? { readyAt: asset.readyAt } : {}),
    ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
    ...(asset.origin ? { origin: structuredClone(asset.origin) } : {}),
    metadata: structuredClone(asset.metadata ?? {}),
  });
}
