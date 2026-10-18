/** Internal caller identity. Tags never come from worker request payloads. */
export type OwnerPrincipal =
  | Readonly<{ kind: "worker"; workerId: string }>
  | Readonly<{
    kind: "owner-control";
    ownerId: string;
    epoch: number;
    holderId: string;
  }>
  | Readonly<{
    kind: "owner-local";
    ownerId: string;
    epoch: number;
    holderId: string;
    deliveryId: string;
    attemptId: string;
  }>;

function invalid(): never {
  throw Object.assign(new Error("Invalid owner caller principal."), {
    name: "OwnerCommandError",
    code: "owner_command_invalid",
  });
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    invalid();
  }
}
/** The separate tag and fixed-order JSON tuple cannot collide across principal kinds. */
export function ownerPrincipalIdentity(value: unknown): Readonly<{
  kind: OwnerPrincipal["kind"];
  id: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const p = value as Record<string, unknown>;
  let fields: string[];
  let tuple: unknown[];
  if (p.kind === "worker") {
    fields = ["kind", "workerId"];
    text(p.workerId);
    tuple = [p.workerId];
  } else if (p.kind === "owner-control" || p.kind === "owner-local") {
    fields = ["kind", "ownerId", "epoch", "holderId"];
    text(p.ownerId);
    text(p.holderId);
    if (!Number.isSafeInteger(p.epoch) || Number(p.epoch) <= 0) invalid();
    tuple = [p.ownerId, p.epoch, p.holderId];
    if (p.kind === "owner-local") {
      fields.push("deliveryId", "attemptId");
      text(p.deliveryId);
      text(p.attemptId);
      tuple.push(p.deliveryId, p.attemptId);
    }
  } else invalid();
  const keys = Object.keys(p);
  if (
    keys.length !== fields.length || keys.some((key) => !fields.includes(key))
  ) invalid();
  const id = JSON.stringify(tuple);
  if (id.length > 8192) invalid();
  return { kind: p.kind as OwnerPrincipal["kind"], id };
}

/** Current owner authority is checked before any caller authorization hook. */
export function assertOwnerPrincipalFence(
  principal: OwnerPrincipal,
  ownerEpoch: number,
  expected: Readonly<{ ownerId: string; epoch: number; holderId: string }>,
): void {
  if (
    ownerEpoch !== expected.epoch || (principal.kind !== "worker" && (
      principal.ownerId !== expected.ownerId ||
      principal.epoch !== ownerEpoch ||
      principal.holderId !== expected.holderId
    ))
  ) {
    throw Object.assign(
      new Error("Caller owner principal is stale or mismatched."),
      {
        name: "ActionOwnershipLost",
        code: "ActionOwnershipLost",
      },
    );
  }
}
