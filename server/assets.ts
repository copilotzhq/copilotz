import type { AssetRecord } from "../runtime/content/index.ts";

/** Safe transport metadata. Physical body locations remain server-private. */
export type EventNativeAsset = Omit<AssetRecord, "location">;

export function eventNativeAsset(asset: AssetRecord): EventNativeAsset {
  const { location: _location, ...safe } = asset;
  return Object.freeze(structuredClone(safe));
}
