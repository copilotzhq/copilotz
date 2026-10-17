import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createExecutionHeartbeat } from "./execution-heartbeat.ts";

function fixture(
  renew: Parameters<
    typeof createExecutionHeartbeat<{ id: string }>
  >[0]["renew"],
  lease = { remainingMs: 80, renewAfterMs: 5 },
) {
  const failures: unknown[] = [];
  const heartbeat = createExecutionHeartbeat({
    reference: { id: "original" },
    lease,
    started: performance.now(),
    renew,
    validate(value, expected) {
      assert.equal(value.id, expected.id);
    },
    fail: (error) => {
      failures.push(error);
    },
  });
  return { heartbeat, failures };
}
test("shared heartbeat serializes renewal and stop drains the only in-flight call", async () => {
  let resolve!: (
    value: {
      status: "committed";
      result: {
        id: string;
        lease: { remainingMs: number; renewAfterMs: number };
      };
    },
  ) => void;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  await delay(15);
  assert.equal(calls, 1);
  let stopped = false;
  const stop = f.heartbeat.stop().then(() => {
    stopped = true;
  });
  await delay(1);
  assert.equal(stopped, false);
  resolve({
    status: "committed",
    result: { id: "original", lease: { remainingMs: 80, renewAfterMs: 5 } },
  });
  await stop;
  await delay(10);
  assert.equal(calls, 1);
  assert.deepEqual(f.failures, []);
});
test("shared heartbeat treats duplicate timing and a wrong reference as lost authority", async () => {
  for (const mode of ["duplicate", "wrong"] as const) {
    const f = fixture(() =>
      Promise.resolve({
        status: mode === "duplicate" ? "duplicate" : "committed",
        result: {
          id: mode === "wrong" ? "foreign" : "original",
          lease: { remainingMs: 1000, renewAfterMs: 100 },
        },
      })
    );
    await delay(15);
    await f.heartbeat.stop();
    assert.equal(f.failures.length, 1);
    if (mode === "duplicate") {
      assert.equal(
        (f.failures[0] as { indeterminate?: boolean }).indeterminate,
        true,
      );
    }
  }
});
test("shared heartbeat timeout stays unknown after late successful reply", async () => {
  let resolve!: (
    value: {
      status: "committed";
      result: {
        id: string;
        lease: { remainingMs: number; renewAfterMs: number };
      };
    },
  ) => void;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  }, { remainingMs: 35, renewAfterMs: 5 });
  await delay(55);
  assert.equal(f.failures.length, 1);
  assert.equal(
    (f.failures[0] as { indeterminate?: boolean }).indeterminate,
    true,
  );
  resolve({
    status: "committed",
    result: { id: "original", lease: { remainingMs: 1000, renewAfterMs: 100 } },
  });
  await f.heartbeat.stop();
  await delay(5);
  assert.equal(calls, 1);
  assert.equal(f.failures.length, 1);
});
