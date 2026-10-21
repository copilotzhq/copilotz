/** Identity columns whose names do not end in `_id`. Keep byte comparisons. */
export const STORAGE_IDENTITY_COLUMNS = [
  "namespace",
  "id",
  "owner",
  "holder",
  "principal",
  "lease_owner",
  "tenant",
  "key",
  "effect_key",
  "accepted_operation",
  "consumed_run",
  "copy_key",
  "current_copy",
  "pending_ref",
  "selection_key",
  "token",
  "version_token",
  "step",
] as const;
export function isStorageIdentityColumn(name: string): boolean {
  return name.endsWith("_id") ||
    STORAGE_IDENTITY_COLUMNS.some((column) => column === name);
}
