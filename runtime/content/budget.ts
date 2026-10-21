/** Planning which bodies a budgeted read resolves and which it defers. @module */
import type { AssetRecord, ContentBudget, ContentDeferral } from "./types.ts";

/**
 * Decides, in the order given, which unique bodies fit the budget. A body
 * larger than `maxBodyBytes` is deferred as `size` and never counts. Bodies
 * then resolve while they fit; once one does not, it and every later body are
 * deferred as `budget`, so the earliest bodies (a feed reads newest first)
 * always win and the outcome depends only on the order and the sizes.
 */
export function planContentBudget(
  assets: readonly Pick<AssetRecord, "id" | "byteLength">[],
  budget: ContentBudget,
): readonly ("read" | ContentDeferral)[] {
  const { maxBytes } = budget;
  const maxBodyBytes = budget.maxBodyBytes ?? maxBytes;
  for (
    const [name, value] of [["maxBytes", maxBytes], [
      "maxBodyBytes",
      maxBodyBytes,
    ]] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
  }
  const decided = new Map<string, "read" | ContentDeferral>();
  let used = 0, exhausted = false;
  return assets.map((asset) => {
    const known = decided.get(asset.id);
    if (known) return known; // One body, one decision, counted once.
    let decision: "read" | ContentDeferral;
    if (asset.byteLength > maxBodyBytes) decision = "size";
    else if (exhausted || used + asset.byteLength > maxBytes) {
      exhausted = true;
      decision = "budget";
    } else {
      used += asset.byteLength;
      decision = "read";
    }
    decided.set(asset.id, decision);
    return decision;
  });
}
