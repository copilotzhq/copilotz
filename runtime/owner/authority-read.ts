/** Private SQL authority mode, chosen only by the host's actual backend scope.
 * Normal command/current-PostgreSQL validation always keeps row locks. The
 * exclusive-read variant is valid only while certified PGlite exclusivity is
 * held; it grants no caller, assignment, Collection or historical authority. */
export type OwnerAuthorityReadMode = "locking" | "exclusive-read";

/** Select a static clause where SQL is constructed; never rewrite caller SQL. */
export function ownerAuthorityLock(
  mode: OwnerAuthorityReadMode,
  clause: " FOR UPDATE" | " FOR UPDATE OF d" | " FOR SHARE" | " FOR SHARE OF a",
): string {
  if (mode === "locking") return clause;
  if (mode === "exclusive-read") return "";
  throw new TypeError("Unsupported owner authority read mode.");
}
