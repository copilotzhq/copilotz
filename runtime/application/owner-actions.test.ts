import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defineAction } from "../actions/define.ts";
import { createOwnerActionCallers } from "./owner-actions.ts";
import type { OwnerJson } from "../owner/boundary.ts";
const actions = { run: { id: "run", execute: () => null } };
const ref = {
  namespace: "n",
  actionId: "run",
  executionId: "e",
  eventId: "v",
  deliveryId: "d",
};
function fixture(
  overrides: Partial<Parameters<typeof createOwnerActionCallers>[0]["port"]> =
    {},
  extra = {},
) {
  return createOwnerActionCallers({
    actions,
    namespace: "n",
    pollMs: 1,
    maxWaitMs: 1000,
    port: {
      callAction: () => Promise.resolve({ status: "committed", result: ref }),
      actionResult: () =>
        Promise.resolve({ status: "completed", output: "value" }),
      ...overrides,
    },
    ...extra,
  });
}
test("ordinary facade snapshots input/key and polls only the admitted result", async () => {
  let admissions = 0, polls = 0;
  const facade = fixture({
    callAction: (request) => {
      admissions++;
      assert.deepEqual(request, {
        actionAlias: "run",
        input: { value: 1 },
        operationKey: "key",
      });
      return Promise.resolve({ status: "duplicate", result: ref });
    },
    actionResult: (reference) => {
      assert.deepEqual(reference, ref);
      polls++;
      return Promise.resolve<OwnerJson>(
        polls < 3
          ? { status: "pending" }
          : { status: "completed", output: { value: 2 } },
      );
    },
  });
  const input = { value: 1 }, options = { operationKey: "key" };
  const result = facade.actions.run(input, options);
  input.value = 5;
  options.operationKey = "changed";
  assert.deepEqual(await result, { value: 2 });
  assert.equal(admissions, 1);
  assert.equal(polls, 3);
  assert.equal(facade.snapshot().pending, 0);
});
test("ordinary facade never retries unknown admission and refuses unsupported options/prepare", async () => {
  let calls = 0;
  const unknown = Object.assign(new Error("lost"), { indeterminate: true });
  const facade = fixture({
    callAction: () => {
      calls++;
      return Promise.reject(unknown);
    },
  });
  await assert.rejects(facade.actions.run(null), (error) => error === unknown);
  await assert.rejects(
    facade.actions.run(null, { metadata: {} }),
    /action_options_unavailable/,
  );
  let prepared = false;
  await assert.rejects(
    facade.actions.run.prepare(() => {
      prepared = true;
      return { input: null };
    }, { operationKey: "key" }),
    /action_prepare_unavailable/,
  );
  await assert.rejects(
    facade.actions.run.prepareNamed({
      preparation: "context.note",
      recordId: "note",
      mode: "context",
    }, { operationKey: "key" }),
    /action_prepare_unavailable/,
  );
  assert.equal(prepared, false);
  assert.equal(calls, 1);
});
test("ordinary facade validates references and closed terminal variants", async () => {
  for (
    const result of [
      { status: "completed" },
      { status: "completed", output: null, secret: 1 },
      { status: "failed", code: ["action_failed"] },
      { status: "pending", output: null },
    ]
  ) {
    await assert.rejects(
      fixture({
        actionResult: () => Promise.resolve(result as unknown as OwnerJson),
      })
        .actions.run(null),
      /action_result_unavailable/,
    );
  }
  await assert.rejects(
    fixture({
      callAction: () =>
        Promise.resolve({
          status: "committed",
          result: { ...ref, actionId: "other" },
        }),
    }).actions.run(null),
    (error) => {
      assert.equal(
        (error as { code: string }).code,
        "action_admission_unknown",
      );
      assert.equal((error as { indeterminate: boolean }).indeterminate, true);
      return true;
    },
  );
  for (
    const [status, code] of [["failed", "action_failed"], [
      "failed",
      "action_not_completed",
    ], ["cancelled", "action_cancelled"]]
  ) {
    await assert.rejects(
      fixture({ actionResult: () => Promise.resolve({ status, code }) }).actions
        .run(null),
      new RegExp(code),
    );
  }
});
test("ordinary facade bounds cancellation and retains noncooperative reservations", async () => {
  let release!: (value: OwnerJson) => void;
  const facade = fixture({
    actionResult: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  }, { maxPending: 1, maxWaitMs: 20 });
  await assert.rejects(facade.actions.run(null), (error) => {
    assert.equal((error as { code: string }).code, "action_wait_interrupted");
    assert.deepEqual((error as { reference: unknown }).reference, ref);
    assert.equal((error as { admitted: boolean }).admitted, true);
    return true;
  });
  assert.equal(facade.snapshot().pending, 1);
  await assert.rejects(facade.actions.run(null), /action_capacity_exceeded/);
  release({ status: "completed", output: "late" });
  await delay(0);
  assert.equal(facade.snapshot().pending, 0);
  facade.close();
  await assert.rejects(facade.actions.run(null), /action_facade_closed/);
});
test("ordinary facade close and caller abort interrupt result waits without readmission", async () => {
  for (const mode of ["close", "abort"]) {
    let calls = 0;
    const facade = fixture({
      callAction: () => {
        calls++;
        return Promise.resolve({ status: "committed", result: ref });
      },
      actionResult: () => Promise.resolve({ status: "pending" }),
    });
    const abort = new AbortController();
    const pending = facade.actions.run(null, { signal: abort.signal });
    await delay(1);
    if (mode === "close") facade.close();
    else abort.abort(new Error("caller stopped"));
    await assert.rejects(pending);
    assert.equal(calls, 1);
    assert.equal(facade.snapshot().pending, 0);
  }
});

test("ordinary facade retains registered input/output inference", async () => {
  const action = defineAction({
    id: "run",
    execute(input: { value: number }) {
      return { result: input.value };
    },
  });
  const facade = createOwnerActionCallers({
    actions: { run: action },
    namespace: "n",
    port: {
      callAction: () => Promise.resolve({ status: "committed", result: ref }),
      actionResult: () =>
        Promise.resolve({ status: "completed", output: { result: 2 } }),
    },
  });
  const output: { result: number } = await facade.actions.run({ value: 1 });
  assert.equal(output.result, 2);
  async function typeChecks() {
    // @ts-expect-error registered input must stay precise
    await facade.actions.run({ value: "wrong" });
    // @ts-expect-error no inferred phantom Action
    await facade.actions.missing(null);
  }
  void typeChecks;
});

test("interrupted in-flight admission is unknown and retains the requested key", async () => {
  let release!: (value: { status: "committed"; result: typeof ref }) => void;
  const facade = fixture({
    callAction: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  }, { maxPending: 1, maxWaitMs: 10 });
  await assert.rejects(
    facade.actions.run(null, { operationKey: "logical" }),
    (error) => {
      assert.equal((error as { indeterminate?: boolean }).indeterminate, true);
      assert.equal(
        (error as { operationKey?: string }).operationKey,
        "logical",
      );
      assert.equal((error as { admitted?: boolean }).admitted, undefined);
      return true;
    },
  );
  assert.equal(facade.snapshot().pending, 1);
  release({ status: "committed", result: ref });
  await delay(0);
  assert.equal(facade.snapshot().pending, 0);
  const abort = new AbortController();
  abort.abort(new Error("before admission"));
  await assert.rejects(
    facade.actions.run(null, { signal: abort.signal }),
    (error) => {
      assert.equal(
        (error as { indeterminate?: boolean }).indeterminate,
        undefined,
      );
      return true;
    },
  );
});

test("ordinary facade preserves existing trimmed and blank operation keys", async () => {
  const seen: unknown[] = [];
  const facade = fixture({
    callAction: (request) => {
      seen.push(request);
      return Promise.resolve({ status: "committed", result: ref });
    },
  });
  await facade.actions.run(null, { operationKey: "  logical  " });
  await facade.actions.run(null, { operationKey: "   " });
  assert.deepEqual(seen, [
    { actionAlias: "run", input: null, operationKey: "logical" },
    { actionAlias: "run", input: null },
  ]);
});
