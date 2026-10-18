import { createContentError } from "./errors.ts";

/** Reserved in every legacy object key, including nested/path-normalized forms. */
export const OWNER_PHYSICAL_OBJECT_SEGMENT = "__copilotz_owner_physical_v1__";
export const OWNER_PHYSICAL_OBJECT_ROOT = `${OWNER_PHYSICAL_OBJECT_SEGMENT}/`;

export function isOwnerPhysicalObjectKey(key: string): boolean {
  // Check segments anywhere, rather than only a prefix: URL dot-segment
  // normalization must not turn a seemingly legacy key into a private key.
  return key.split(/[\\/]/).includes(OWNER_PHYSICAL_OBJECT_SEGMENT);
}
export function refuseOwnerPhysicalObjectKey(key: string): void {
  if (isOwnerPhysicalObjectKey(key)) {
    throw createContentError(
      "asset_conflict",
      "The object key belongs to the private owner physical namespace.",
    );
  }
}
