import { canonicalJson } from "../data-only-json.ts";
/** Canonical JSON for replay and no-op comparison. Key order is not semantic. */
export const stableStringify = (value: unknown): string =>
  canonicalJson(value, { undefinedValue: "undefined" });

export function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
