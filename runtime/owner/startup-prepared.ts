/** Pure compatibility evidence for closed ordinary prepared Action children.
 * The fenced scanner must inventory ALL rows and prove ordinary lifecycle/body/
 * catalog/assignment validity first. This helper does not query, hydrate, render,
 * authorize a caller, repair storage or grant readiness. Its normalized evidence
 * and derived copies consume the scanner's SAME remaining aggregate budget. */
import { assertJsonValue } from "../json.ts";
import { readExecutionClaim } from "../execution/recovery.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import {
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationChildKey,
  ownerPreparationKey,
} from "../execution/preparation-call.ts";
import type { OwnerStoredAssignment } from "./assignments.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import {
  OWNER_PREPARATION_METADATA,
  parseOwnerPreparationCapture,
} from "./preparation-capture.ts";
import { ownerPreparationIntent } from "./preparation-intent.ts";

export type OwnerPreparedHistoryRegistration = Readonly<{
  name: string;
  actionId: string;
  source: Readonly<{ name: string; kind: string; selection: "record" }>;
  modes: readonly string[];
  resources: readonly Readonly<{ namespace: string; alias: string }>[];
}>;
/** Only canonical closed Actions established by the independent lifecycle
 * checker. No worker-supplied marker may populate this set. */
export type OwnerClosedActionHistory = Readonly<{
  namespace: string;
  actionId: string;
  executionId: string;
  eventId: string;
  deliveryId: string;
  invokedId: string;
  terminalId: string;
  settlementScopeId: string;
  rootEventId: string;
}>;
export type OwnerPreparedHistoryEvent = Readonly<{
  id: string;
  ownerId: string;
  namespace: string;
  type: string;
  metadata: Readonly<Record<string, unknown>>;
  deduplicationId: string | null;
  causationId: string | null;
  correlationId: string | null;
}>;
export type OwnerPreparedHistoryDelivery = Readonly<{
  id: string;
  eventId: string;
  consumerId: string;
  settlementScopeId: string | null;
  actionScopeId: string | null;
  status: string;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}>;
export type OwnerPreparedHistoryReceipt = Readonly<{
  owner: string;
  principalKind: string;
  principalId: string;
  domain: string;
  key: string;
  kind: string;
  intent: unknown;
  result: unknown;
}>;
export type OwnerPreparedHistoryEvidence = Readonly<{
  ownerId: string;
  epoch: number;
  registrations: readonly OwnerPreparedHistoryRegistration[];
  events: readonly OwnerPreparedHistoryEvent[];
  deliveries: readonly OwnerPreparedHistoryDelivery[];
  receipts: readonly OwnerPreparedHistoryReceipt[];
  closedActions: readonly OwnerClosedActionHistory[];
  assignments: readonly OwnerStoredAssignment[];
  maxDerivedItems: number;
  maxDerivedBytes: number;
}>;
export type OwnerPreparedHistoryResult = Readonly<{
  matchedDeliveryIds: readonly string[];
  blockers: readonly Readonly<{
    namespace: string | null;
    id: string;
    reason: "prepared_history_incompatible";
  }>[];
  derivedItems: number;
  derivedBytes: number;
}>;
const invalidErrors = new WeakSet<Error>();
function invalid(): never {
  const error = new TypeError("Prepared history evidence is incompatible.");
  invalidErrors.add(error);
  throw error;
}
function incomplete(): never {
  throw Object.assign(
    new Error("Prepared history inventory exceeds its budget."),
    {
      code: "owner_prepared_history_inventory_incomplete",
    },
  );
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) invalid();
}
function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
  ) invalid();
  return value as Record<string, unknown>;
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length &&
    left.every(([key, value]) =>
      Object.hasOwn(b, key) && equal(value, (b as Record<string, unknown>)[key])
    );
}
function registration(value: OwnerPreparedHistoryRegistration): void {
  exact(value, ["name", "actionId", "source", "modes", "resources"]);
  text(value.name);
  text(value.actionId);
  exact(value.source, ["name", "kind", "selection"]);
  text(value.source.name);
  text(value.source.kind);
  if (
    value.source.selection !== "record" || !Array.isArray(value.modes) ||
    !value.modes.length || new Set(value.modes).size !== value.modes.length ||
    !Array.isArray(value.resources) || value.resources.length > 32
  ) invalid();
  value.modes.forEach(text);
  const keys = new Set<string>();
  for (const ref of value.resources) {
    exact(ref, ["namespace", "alias"]);
    text(ref.namespace);
    text(ref.alias);
    const key = JSON.stringify([ref.namespace, ref.alias]);
    if (keys.has(key)) invalid();
    keys.add(key);
  }
}
function preparationReceipt(row: OwnerPreparedHistoryReceipt): boolean {
  return row.kind === OWNER_CHILD_ACTION_PREPARATION ||
    row.key.startsWith('["action.child-prepare",');
}
/** Caller preflights raw SQL rows. This additionally reserves the detached
 * normalized input, parsers/canonical encodings, maps and bounded result before
 * asynchronous hashing. Budget exhaustion never returns partial matches. */
export async function validateClosedPreparedHistories(
  original: OwnerPreparedHistoryEvidence,
): Promise<OwnerPreparedHistoryResult> {
  assertJsonValue(original, { maxDepth: 40, maxNodes: 1_000_000 });
  const { maxDerivedItems, maxDerivedBytes } = original;
  if (
    !Number.isSafeInteger(maxDerivedItems) || maxDerivedItems < 0 ||
    maxDerivedItems > 1_000_000 || !Number.isSafeInteger(maxDerivedBytes) ||
    maxDerivedBytes < 0 || maxDerivedBytes > 32 * 1024 * 1024
  ) incomplete();
  let derivedItems = 0, derivedBytes = 0;
  function charge(value: unknown, copies = 1) {
    let count = 0;
    function visit(item: unknown): void {
      if (++count + derivedItems > maxDerivedItems) incomplete();
      if (item && typeof item === "object") Object.values(item).forEach(visit);
    }
    visit(value);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength *
      copies;
    if (derivedBytes + bytes > maxDerivedBytes) incomplete();
    derivedItems += count;
    derivedBytes += bytes;
  }
  // Four copies reserve normalization, strict capture/claim parsing, digest
  // encoding and one detached snapshot. No uncharged mutable input survives.
  // Configuration limits themselves must not make the measured evidence size
  // change when the caller supplies exactly that size on a subsequent scan.
  const { maxDerivedItems: _items, maxDerivedBytes: _bytes, ...facts } =
    original;
  charge(facts, 4);
  charge([1_000_000, 32 * 1024 * 1024], 4);
  const input = structuredClone(original);
  text(input.ownerId);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 2) invalid();
  for (
    const values of [
      input.registrations,
      input.events,
      input.deliveries,
      input.receipts,
      input.closedActions,
      input.assignments,
    ]
  ) {
    if (!Array.isArray(values) || values.length > 10_000) incomplete();
  }
  function unique<T>(
    values: readonly T[],
    key: (value: T) => string,
  ): Map<string, T> {
    const map = new Map<string, T>();
    for (const value of values) {
      const id = key(value);
      text(id);
      charge(id);
      if (map.has(id)) invalid();
      map.set(id, value);
    }
    return map;
  }
  input.registrations.forEach(registration);
  const registrations = unique(input.registrations, (value) => value.name);
  const events = unique(input.events, (value) => value.id);
  const deliveries = unique(input.deliveries, (value) => value.id);
  const closed = unique(input.closedActions, (value) => value.deliveryId);
  const prepared = input.events.filter((event) =>
    Object.hasOwn(event.metadata, OWNER_PREPARATION_METADATA)
  );
  const receiptRows = input.receipts.filter(preparationReceipt);
  const matches = new Set<string>();
  const consumed = new Set<OwnerPreparedHistoryReceipt>();
  const blockers: {
    namespace: string | null;
    id: string;
    reason: "prepared_history_incompatible";
  }[] = [];
  function block(namespace: string | null, id: string) {
    const value = {
      namespace,
      id,
      reason: "prepared_history_incompatible" as const,
    };
    charge(value);
    blockers.push(value);
  }
  function closedAction(
    event: OwnerPreparedHistoryEvent,
    delivery: OwnerPreparedHistoryDelivery,
  ) {
    const proof = closed.get(delivery.id), m = event.metadata;
    if (
      !proof || event.ownerId !== input.ownerId ||
      event.type !== "copilotz.owner.action.requested" ||
      proof.eventId !== event.id || proof.namespace !== event.namespace ||
      proof.actionId !== m.actionId || proof.executionId !== m.actionRunId ||
      event.deduplicationId !== proof.executionId ||
      delivery.eventId !== event.id ||
      delivery.consumerId !== `registered:${proof.actionId}` ||
      !["succeeded", "dead_letter", "cancelled"].includes(delivery.status) ||
      delivery.attempts !== 1 || delivery.leaseOwner !== null ||
      delivery.leaseExpiresAt !== null || delivery.actionScopeId !== null ||
      !delivery.settlementScopeId ||
      proof.settlementScopeId !== delivery.settlementScopeId ||
      !events.has(proof.rootEventId) || !events.has(proof.invokedId) ||
      !events.has(proof.terminalId)
    ) invalid();
    const claims = input.receipts.filter((row) =>
      row.kind === "execution.claim" &&
      row.result && typeof row.result === "object" &&
      (row.result as Record<string, unknown>).deliveryId === delivery.id
    );
    if (claims.length !== 1) invalid();
    const claim = claims[0];
    const intent = exact(claim.intent, ["assignmentId", "sessionId"]);
    let parsed;
    try {
      parsed = readExecutionClaim(claim.result);
    } catch {
      invalid();
    }
    const ref = parsed.reference;
    if (
      ref.executionId !== proof.executionId || ref.deliveryId !== delivery.id ||
      claim.owner !== input.ownerId || claim.domain !== "incarnation" ||
      claim.principalKind !== "worker" || parsed.recovery !== undefined ||
      typeof intent.assignmentId !== "string" ||
      typeof intent.sessionId !== "string" ||
      claim.key !==
        ownerClaimKey(input.ownerId, intent.assignmentId, intent.sessionId)
    ) invalid();
    const histories = input.assignments.filter((value) =>
      value.binding.deliveryId === delivery.id
    );
    const executed = histories.filter(({ binding }) =>
      binding.placement === "worker" &&
      binding.assignmentId === intent.assignmentId &&
      binding.sessionId === intent.sessionId
    );
    if (executed.length !== 1) invalid();
    for (const history of histories) {
      const b = history.binding;
      if (
        history.owner !== input.ownerId || history.epoch >= input.epoch ||
        b.placement !== "worker" || "kind" in b ||
        b.namespace !== event.namespace ||
        b.sourceEventId !== event.id || b.actionId !== proof.actionId ||
        b.executionId !== proof.executionId ||
        (history !== executed[0] && !history.retired)
      ) invalid();
    }
    const b = executed[0].binding;
    if (
      b.placement !== "worker" || "kind" in b ||
      b.dispatchAttemptId !== ref.dispatchAttemptId ||
      claim.principalId !==
        ownerPrincipalIdentity({ kind: "worker", workerId: b.workerId }).id
    ) invalid();
    if (
      parsed.contract && !equal(parsed.contract, {
        protocol: "copilotz.owner-effects.v1",
        attempt: 1,
        ownerEpoch: executed[0].epoch,
        ownerId: input.ownerId,
        namespace: b.namespace,
        actionId: b.actionId,
        actionRunId: b.executionId,
        sourceEventId: b.sourceEventId,
        deliveryId: b.deliveryId,
        workerId: b.workerId,
        assignmentId: b.assignmentId,
        sessionId: b.sessionId,
        dispatchAttemptId: b.dispatchAttemptId,
      })
    ) invalid();
    return { proof, claim };
  }
  for (const event of prepared) {
    try {
      const capture = parseOwnerPreparationCapture(
        event.metadata[OWNER_PREPARATION_METADATA],
      );
      const registered = registrations.get(capture.preparation);
      if (
        !registered || capture.source.source.namespace !== event.namespace ||
        capture.source.source.name !== registered.source.name ||
        capture.source.source.kind !== registered.source.kind ||
        !("selection" in capture.source.source) ||
        capture.source.source.selection !== "record" ||
        capture.source.content.length ||
        registered.actionId !== event.metadata.actionId ||
        !registered.modes.includes(capture.view.hints.mode) ||
        capture.resources.some((ref) =>
          !registered.resources.some((allowed) =>
            allowed.namespace === ref.namespace && allowed.alias === ref.alias
          )
        )
      ) invalid();
      const children = input.deliveries.filter((row) =>
        row.eventId === event.id
      );
      if (children.length !== 1) invalid();
      const child = children[0];
      const { proof: childProof } = closedAction(event, child);
      text(event.metadata.parentDeliveryId);
      const parent = deliveries.get(event.metadata.parentDeliveryId);
      const parentEvent = parent && events.get(parent.eventId);
      if (
        !parent || !parentEvent || parentEvent.id === event.id ||
        Object.hasOwn(parentEvent.metadata, OWNER_PREPARATION_METADATA)
      ) invalid();
      const { proof: parentProof, claim: parentClaim } = closedAction(
        parentEvent,
        parent,
      );
      const m = event.metadata, p = parentEvent.metadata;
      if (
        ["parentDeliveryId", "parentOperationKey", "parentActionRunId"].some((
          key,
        ) => Object.hasOwn(p, key)) ||
        (Object.hasOwn(p, "childDepth") && p.childDepth !== 0) ||
        (Object.hasOwn(p, "rootKey") &&
          p.rootKey !== parentProof.executionId) ||
        parentProof.rootEventId !== parentEvent.id ||
        childProof.rootEventId !== parentEvent.id ||
        event.causationId !== parentEvent.id ||
        event.namespace !== parentEvent.namespace ||
        event.correlationId !== parentEvent.correlationId ||
        child.settlementScopeId !== parent.settlementScopeId ||
        m.parentActionRunId !== parentProof.executionId ||
        m.parentOperationKey !== parentProof.executionId ||
        m.rootKey !== (p.rootKey ?? parentProof.executionId) ||
        !Number.isSafeInteger(m.childDepth) ||
        !Number.isSafeInteger(p.childDepth ?? 0) ||
        Number(m.childDepth) !== Number(p.childDepth ?? 0) + 1
      ) invalid();
      text(m.localOperationKey);
      if (!m.localOperationKey.startsWith("prepare:")) invalid();
      let local: unknown;
      try {
        local = JSON.parse(m.localOperationKey.slice(8));
      } catch {
        invalid();
      }
      if (
        !Array.isArray(local) || local.length !== 2 ||
        local[0] !== capture.preparation
      ) invalid();
      text(local[1]);
      if (
        m.localOperationKey !==
          ownerPreparationChildKey(capture.preparation, local[1]) ||
        m.actionRunId !==
          `${parentProof.executionId}/action:${registered.actionId}:${m.localOperationKey}`
      ) invalid();
      const key = ownerPreparationKey(
        input.ownerId,
        event.namespace,
        parentProof.executionId,
        capture.preparation,
        local[1],
      );
      const rows = receiptRows.filter((row) => row.key === key);
      if (rows.length !== 1) invalid();
      const receipt = rows[0];
      if (
        receipt.owner !== input.ownerId || receipt.domain !== "logical" ||
        receipt.kind !== OWNER_CHILD_ACTION_PREPARATION ||
        receipt.principalKind !== "worker" ||
        receipt.principalId !== parentClaim.principalId ||
        !equal(receipt.result, {
          namespace: event.namespace,
          actionId: registered.actionId,
          executionId: m.actionRunId,
          eventId: event.id,
          deliveryId: child.id,
        })
      ) invalid();
      const intent = await ownerPreparationIntent({
        preparation: capture.preparation,
        operationKey: local[1],
        parentOperationKey: parentProof.executionId,
        source: capture.source.source.name,
        recordId: capture.source.source.recordId,
        actionId: registered.actionId,
        hints: capture.view.hints,
      });
      if (!equal(receipt.intent, intent) || consumed.has(receipt)) invalid();
      charge(child.id);
      matches.add(child.id);
      consumed.add(receipt);
    } catch (error) {
      if (
        error instanceof Error && (invalidErrors.has(error) ||
          ("code" in error && error.code === "preparation_capture_invalid"))
      ) {
        block(event.namespace, event.id);
      } else throw error;
    }
  }
  for (const receipt of receiptRows) {
    if (!consumed.has(receipt)) block(null, receipt.key);
  }
  return {
    matchedDeliveryIds: [...matches],
    blockers,
    derivedItems,
    derivedBytes,
  };
}
