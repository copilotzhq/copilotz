import type { MutationIdentity } from "./types.ts";

export function workflowObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return workflowObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

export function workflowMutationId(
  kind: string,
  namespace: string,
  explicit: string | undefined,
  identity: MutationIdentity | undefined,
  createId: () => string,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (identity?.deduplicationId?.trim()) {
    return `${namespace}:${kind}:${identity.deduplicationId.trim()}`;
  }
  return createId();
}
