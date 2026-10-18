/** Shared durable alarm identity for actual startup and lost-Action recovery. */
const kinds = [
  "delivery",
  "assignment",
  "action",
  "operation",
  "stream",
  "effect",
  "claim",
  "alarm",
  "blocker",
] as const;
export type OwnerReconciliationTarget = Readonly<{
  kind: typeof kinds[number];
  /** null is retained corruption evidence, never an invented namespace. */
  namespace: string | null;
  id: string;
}>;
export function ownerReconciliationAlarm(
  ownerId: string,
  value: OwnerReconciliationTarget,
): string {
  return JSON.stringify([
    "reconciliation",
    ownerId,
    value.kind,
    value.namespace,
    value.id,
  ]);
}
