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
