import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerReconciliationAlarm } from "./reconciliation.ts";

test("reconciliation alarm identity preserves nullable namespaces and exact escaping", () => {
  assert.equal(
    ownerReconciliationAlarm("owner", {
      kind: "alarm",
      namespace: null,
      id: "unknown-alarm",
    }),
    '["reconciliation","owner","alarm",null,"unknown-alarm"]',
  );
  const target = {
    kind: "action" as const,
    namespace: "space",
    id: 'quoted"action',
  };
  assert.deepEqual(JSON.parse(ownerReconciliationAlarm("owner", target)), [
    "reconciliation",
    "owner",
    "action",
    "space",
    'quoted"action',
  ]);
});
