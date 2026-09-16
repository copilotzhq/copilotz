/** Current Core thread metadata: public data and opaque plugin-owned system namespaces. */
export interface StructuredThreadMetadata {
  public?: Record<string, unknown>;
  system?: Record<string, unknown>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? structuredClone(value) : {};
}
function removeUndefinedKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
export function normalizeThreadMetadata(
  raw: unknown,
): StructuredThreadMetadata {
  const value = isRecord(raw) ? raw : {};
  return {
    public: cloneRecord(value.public),
    system: cloneRecord(value.system),
  };
}
export function mergeThreadMetadata(
  base: unknown,
  patch: unknown,
): StructuredThreadMetadata {
  const before = normalizeThreadMetadata(base),
    after = normalizeThreadMetadata(patch);
  return {
    public: removeUndefinedKeys({ ...before.public, ...after.public }),
    system: removeUndefinedKeys({ ...before.system, ...after.system }),
  };
}
export function getPublicThreadMetadata(raw: unknown): Record<string, unknown> {
  return normalizeThreadMetadata(raw).public!;
}
export function getSerializableThreadMetadata(
  raw: unknown,
): Record<string, unknown> | null {
  const value = normalizeThreadMetadata(raw);
  const result = {
    ...(Object.keys(value.public!).length ? { public: value.public } : {}),
    ...(Object.keys(value.system!).length ? { system: value.system } : {}),
  };
  return Object.keys(result).length ? result : null;
}
