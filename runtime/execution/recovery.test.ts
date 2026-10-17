import assert from "node:assert/strict";
import { test } from "node:test";
import { readExecutionClaim, readExecutionRecovery } from "./recovery.ts";

const ref = {
  executionId: "run",
  deliveryId: "delivery",
  dispatchAttemptId: "attempt",
};
test("claim parser accepts only exact reference plus bounded recovery marker, no outcome hydration", () => {
  assert.deepEqual(readExecutionClaim(ref), { reference: ref });
  const recovery = {
    status: "eligible",
    effects: [{ step: "send", status: "begun" }],
  };
  assert.deepEqual(readExecutionClaim({ ...ref, recovery }), {
    reference: ref,
    recovery,
  });
  for (
    const bad of [
      { ...recovery, extra: true },
      { status: "execute", effects: [] },
      {
        status: "eligible",
        effects: [{ step: "send", status: "confirmed", outcome: "secret" }],
      },
      {
        status: "eligible",
        effects: [{ step: "send", status: "begun" }, {
          step: "send",
          status: "confirmed",
        }],
      },
      {
        status: "eligible",
        effects: Array.from(
          { length: 101 },
          (_, i) => ({ step: String(i), status: "begun" }),
        ),
      },
    ]
  ) assert.throws(() => readExecutionRecovery(bad));
  assert.throws(() => readExecutionClaim({ ...ref, unexpected: true }));
});

test("historical execution contract is exact bounded provenance and cannot accompany a retry marker", () => {
  const contract = {
    protocol: "copilotz.owner-effects.v1",
    attempt: 1,
    ownerEpoch: 1,
    ownerId: "owner",
    namespace: "space",
    actionId: "work",
    actionRunId: "run",
    sourceEventId: "event",
    deliveryId: "delivery",
    workerId: "worker",
    assignmentId: "assignment",
    sessionId: "session",
    dispatchAttemptId: "attempt",
  };
  const parsed = readExecutionClaim({ ...ref, contract });
  assert.deepEqual(parsed.contract, contract);
  contract.workerId = "mutated";
  assert.equal(parsed.contract?.workerId, "worker");
  for (
    const bad of [
      { ...contract, protocol: "future" },
      { ...contract, attempt: 2 },
      { ...contract, ownerEpoch: 0 },
      { ...contract, ownerEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...contract, assignmentId: "" },
      { ...contract, sessionId: "x".repeat(1025) },
      { ...contract, actionRunId: "other" },
      { ...contract, deliveryId: "other" },
      { ...contract, dispatchAttemptId: "other" },
      { ...contract, safe: true },
      null,
    ]
  ) assert.throws(() => readExecutionClaim({ ...ref, contract: bad }));
  assert.throws(() =>
    readExecutionClaim({
      ...ref,
      contract,
      recovery: { status: "eligible", effects: [] },
    })
  );
});
