import { cloneContentRef } from "./input.ts";
import type { PreparedAsset, PreparedContent } from "./types.ts";

/** Combines prepared batches while deduplicating identical newly prepared bodies. */
export function mergePreparedContent(
  ...batches: readonly (PreparedContent | undefined)[]
): PreparedContent | undefined {
  const present = batches.filter((batch): batch is PreparedContent =>
    Boolean(batch)
  );
  if (present.length === 0) return undefined;
  const assets: PreparedAsset[] = [];
  const identity = new Map<string, PreparedAsset>();
  const remap = new Map<string, string>();
  for (const batch of present) {
    for (const asset of batch.assets) {
      const key =
        `${asset.mediaType}\u0000${asset.byteLength}\u0000${asset.digest}`;
      const existing = identity.get(key);
      if (existing) {
        remap.set(asset.id, existing.id);
      } else {
        identity.set(key, asset);
        assets.push(asset);
      }
    }
  }
  return Object.freeze({
    content: Object.freeze(
      present.flatMap((batch) =>
        batch.content.map((ref) =>
          cloneContentRef({
            ...ref,
            assetId: remap.get(ref.assetId) ?? ref.assetId,
          })
        )
      ),
    ),
    assets: Object.freeze(assets),
  });
}
