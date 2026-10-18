/** Private coordinate checks and command-context derivation only. None of these
 * helpers authenticates a caller, resolves a reservation, fences the current SQL
 * owner, or grants execution permission. Those checks belong to the command. */
import type { OwnerEventCommitContext } from "../events/store.ts";
import type { EventDelivery } from "../events/types.ts";
import {
  type OwnerLocalAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
import type { OwnerCaller, OwnerCommandContext } from "./boundary.ts";
import { ownerPrincipalIdentity } from "./principal.ts";

/** Compare stable assignment facts independently of unrelated capability grants.
 * The caller must separately require the grant for its current phase. */
export type OwnerAssignmentFacts<T> = T extends unknown
  ? Omit<T, "ctxGranted" | "settlementGranted">
  : never;
export function ownerAssignmentFacts<
  T extends Readonly<{
    ctxGranted: boolean;
    settlementGranted: boolean;
  }>,
>(value: T): OwnerAssignmentFacts<T> {
  const { ctxGranted: _ctx, settlementGranted: _settlement, ...facts } = value;
  return facts as OwnerAssignmentFacts<T>;
}

/** Structural subset of a verified, host-owned worker assignment. Rich Action
 * and Processor assignments may carry business facts alongside these fields. */
export type OwnerWorkerAttemptAuthority = Readonly<{
  placement: "worker";
  ownerId: string;
  workerId: string;
  assignmentId: string;
  sessionId: string;
  dispatchAttemptId: string;
  deliveryId: string;
}>;
export type OwnerAttemptAuthority =
  | OwnerWorkerAttemptAuthority
  | OwnerLocalAssignmentBinding;

const workerFields = [
  "placement",
  "ownerId",
  "workerId",
  "assignmentId",
  "sessionId",
  "dispatchAttemptId",
  "deliveryId",
] as const;
const workerOnlyFields = [
  "workerId",
  "workerAttemptId",
  "sessionGeneration",
  "sessionId",
  "parentOperationId",
  "assignmentId",
  "dispatchAttemptId",
  "executionId",
] as const;
const localOnlyFields = [
  "epoch",
  "holderId",
  "attemptId",
  "actionRunId",
] as const;
const localFields = [
  "placement",
  "ownerId",
  "epoch",
  "holderId",
  "attemptId",
  "namespace",
  "sourceEventId",
  "deliveryId",
  "kind",
] as const;

function invalid(): never {
  throw new TypeError("Invalid owner attempt authority.");
}
function refuse(): never {
  throw Object.assign(new Error("Owner attempt authority does not match."), {
    name: "ActionOwnershipLost",
    code: "ActionOwnershipLost",
  });
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) invalid();
}
function epoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid();
}
function record(value: unknown): object {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value;
}
/** Read a coordinate once without invoking accessors or accepting inheritance. */
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  return descriptor.value;
}
function optionalField(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? field(value, key) : undefined;
}
function select(value: object, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, field(value, key)]));
}
function rejectFields(value: object, keys: readonly string[]) {
  if (keys.some((key) => Object.hasOwn(value, key))) invalid();
}
function exactRecord(value: unknown, keys: readonly string[]) {
  const input = record(value);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  ) invalid();
  return select(input, keys);
}
function authority(value: OwnerAttemptAuthority): OwnerAttemptAuthority {
  const input = record(value);
  const placement = field(input, "placement");
  if (placement === "worker") {
    rejectFields(input, localOnlyFields);
    const result = select(input, workerFields);
    for (const value of Object.values(result)) identifier(value);
    return result as OwnerWorkerAttemptAuthority;
  }
  if (placement !== "owner-local") invalid();
  rejectFields(input, workerOnlyFields);
  const kind = field(input, "kind");
  if (kind !== "action" && kind !== "processor") invalid();
  rejectFields(
    input,
    kind === "action"
      ? ["processorId", "consumerId"]
      : ["actionId", "actionRunId"],
  );
  // Reuse the canonical binding decoder, including its encoded-byte bound and
  // Processor consumer identity. Grants/invocation are not authority fields.
  return parseOwnerPlacementBinding(select(input, [
    ...localFields,
    ...(kind === "action"
      ? ["actionId", "actionRunId"]
      : ["processorId", "consumerId"]),
  ])) as OwnerLocalAssignmentBinding;
}

/** Compare an already-authenticated caller with its independently verified
 * assignment. In particular, an owner-control caller is not an attempt. */
export function assertOwnerAttemptCaller(
  caller: OwnerCaller,
  assignment: OwnerAttemptAuthority,
  ownerId: string,
): void {
  const expected = authority(assignment);
  identifier(ownerId);
  const input = record(caller);
  const principal = record(field(input, "principal"));
  const kind = field(principal, "kind");
  const actual = exactRecord(
    principal,
    kind === "worker"
      ? ["kind", "workerId"]
      : kind === "owner-local"
      ? ["kind", "ownerId", "epoch", "holderId", "deliveryId", "attemptId"]
      : kind === "owner-control"
      ? ["kind", "ownerId", "epoch", "holderId"]
      : invalid(),
  );
  ownerPrincipalIdentity(actual);
  for (const [key, value] of Object.entries(actual)) {
    if (key !== "epoch") identifier(value);
  }
  const ownerEpoch = field(input, "ownerEpoch");
  epoch(ownerEpoch);
  if (expected.ownerId !== ownerId) refuse();
  if (expected.placement === "worker") {
    if (
      kind !== "worker" || actual.workerId !== expected.workerId ||
      field(input, "assignmentId") !== expected.assignmentId ||
      field(input, "sessionId") !== expected.sessionId ||
      field(input, "dispatchAttemptId") !== expected.dispatchAttemptId
    ) refuse();
    return;
  }
  if (
    kind !== "owner-local" || actual.ownerId !== expected.ownerId ||
    actual.epoch !== expected.epoch || actual.holderId !== expected.holderId ||
    actual.deliveryId !== expected.deliveryId ||
    actual.attemptId !== expected.attemptId || ownerEpoch !== expected.epoch
  ) refuse();
}

export function ownerAttemptToken(assignment: OwnerAttemptAuthority): string {
  const expected = authority(assignment);
  return expected.placement === "worker"
    ? expected.dispatchAttemptId
    : expected.attemptId;
}

/** Delivery representation check only, never a substitute for the command's
 * current owner fence, durable reservation resolution, or current policy. */
export function ownerAttemptIsLive(
  delivery: EventDelivery,
  assignment: OwnerAttemptAuthority,
): boolean {
  const expected = authority(assignment);
  const input = record(delivery);
  const id = field(input, "id");
  const status = field(input, "status");
  const leaseOwner = optionalField(input, "leaseOwner");
  const leaseExpiresAt = optionalField(input, "leaseExpiresAt");
  const token = expected.placement === "worker"
    ? expected.dispatchAttemptId
    : expected.attemptId;
  if (
    id !== expected.deliveryId || status !== "leased" || leaseOwner !== token
  ) return false;
  // Both placements use a non-expiring owner-controlled attempt. The exact
  // assignment/session and epoch must already have been authenticated.
  return leaseExpiresAt === undefined || leaseExpiresAt === null;
}

/** Convert already-authorized command state. A separately authorized local
 * start may have an owner-control caller; caller tags never select placement.
 * This preserves capability identities, but snapshots the local selector. */
export function ownerEventCommitForAttempt(
  context: Pick<
    OwnerCommandContext,
    "tx" | "commandTime" | "ownerCommit" | "afterCommit"
  >,
  assignment: OwnerAttemptAuthority,
): OwnerEventCommitContext {
  const expected = authority(assignment);
  const input = record(context);
  const owner = record(field(input, "ownerCommit"));
  const commit = select(owner, [
    "transaction",
    "ownerId",
    "epoch",
    "holderId",
    "commandTime",
  ]);
  identifier(commit.ownerId);
  identifier(commit.holderId);
  epoch(commit.epoch);
  const commandTime = field(input, "commandTime");
  const tx = field(input, "tx");
  const afterCommit = field(input, "afterCommit");
  if (
    typeof commandTime !== "string" ||
    !Number.isFinite(Date.parse(commandTime)) ||
    typeof afterCommit !== "function"
  ) invalid();
  if (
    commit.transaction !== tx || commit.ownerId !== expected.ownerId ||
    commit.commandTime !== commandTime
  ) refuse();
  if (
    expected.placement === "owner-local" &&
    (commit.epoch !== expected.epoch || commit.holderId !== expected.holderId)
  ) refuse();
  if (Object.hasOwn(owner, "ownerAttempt")) {
    const previous = exactRecord(field(owner, "ownerAttempt"), [
      "deliveryId",
      "attemptId",
    ]);
    if (
      previous.deliveryId !== expected.deliveryId ||
      previous.attemptId !== ownerAttemptToken(expected)
    ) refuse();
  }
  return {
    transaction: tx as OwnerCommandContext["tx"],
    ownerId: commit.ownerId,
    epoch: commit.epoch,
    holderId: commit.holderId,
    commandTime,
    afterCommit: afterCommit as OwnerCommandContext["afterCommit"],
    ownerAttempt: {
      deliveryId: expected.deliveryId,
      attemptId: ownerAttemptToken(expected),
    },
  };
}
