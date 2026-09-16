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
  return ({
    content: present.flatMap((batch) =>
      batch.content.map((ref) =>
        cloneContentRef({
          ...ref,
          assetId: remap.get(ref.assetId) ?? ref.assetId,
        })
      )
    ),
    assets: assets,
  } as const);
}

/** Reuse a sealed body's storage only when it exactly matches the target content. */
export function adoptPreparedBody(
  target: PreparedContent,
  source: PreparedContent,
): PreparedContent | undefined {
  if (
    target.content.length !== 1 || target.assets.length !== 1 ||
    source.content.length !== 1 || source.assets.length !== 1
  ) return undefined;
  const final = target.assets[0];
  const ready = source.assets[0];
  if (
    target.content[0].assetId !== final.id ||
    source.content[0].assetId !== ready.id ||
    !ready.readyBody || !ready.location ||
    final.namespace !== ready.namespace ||
    final.mediaType !== ready.mediaType ||
    final.byteLength !== ready.byteLength || final.digest !== ready.digest
  ) return undefined;
  return ({
    content: target.content,
    assets: [
      {
        ...final,
        body: new Uint8Array(),
        readyBody: ready.readyBody,
        location: ready.location,
      } as const,
    ] as const,
  } as const);
}
