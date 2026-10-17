import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerLocalActionStartKey } from "./execution.ts";
import type { OwnerLocalActionAssignmentBinding } from "./assignments.ts";

const binding: OwnerLocalActionAssignmentBinding = {
  placement: "owner-local",
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
  kind: "action",
  actionId: "work",
  actionRunId: "run",
};
test("local Action start key is exact, canonical, and never evaluates coordinate accessors", () => {
  assert.equal(
    ownerLocalActionStartKey(binding),
    JSON.stringify([
      "owner.local-start",
      1,
      "owner",
      1,
      "holder",
      "delivery",
      "attempt",
    ]),
  );
  for (const key of Object.keys(binding)) {
    let invoked = false;
    const altered = Object.defineProperty({ ...binding }, key, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("accessor invoked");
      },
    });
    assert.throws(
      () => ownerLocalActionStartKey(altered),
      /own data coordinates/,
    );
    assert.equal(invoked, false);
  }
  assert.throws(() =>
    ownerLocalActionStartKey({ ...binding, attemptId: " padded " })
  );
});
