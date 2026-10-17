import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { OwnerInputCommand, OwnerJson } from "../owner/boundary.ts";
import {
  createOwnerChildActionPort,
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  ownerChildActionKey,
} from "./child-action-port.ts";

const registry = createPluginRegistry({
  actions: {
    child: defineAction({
      id: "fixture.child",
      execute: (value: unknown) => value,
    }),
    other: defineAction({
      id: "fixture.other",
      execute: (value: unknown) => value,
    }),
  },
});
const reference = {
  deliveryId: "parent-delivery",
  dispatchAttemptId: "parent-attempt",
};
const errorCode = (code: string) => (error: unknown) =>
  (error as { code?: string })?.code === code;

function setup(
  encoded = false,
  result: OwnerJson = { status: "completed", output: { value: 7 } },
) {
  const calls: OwnerInputCommand[] = [];
  const projections: OwnerJson[] = [];
  let pending = true;
  const pass = <T>(value: T): T =>
    encoded ? JSON.parse(JSON.stringify(value)) : value;
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 1000,
    pollMs: 1,
    port: {
      executeInput(command) {
        calls.push(pass(command));
        const input = command.input as Record<string, OwnerJson>;
        const action = registry.actions[input.actionAlias as "child" | "other"];
        return Promise.resolve(pass({
          status: "committed",
          result: {
            namespace: "space",
            actionId: action.id,
            executionId: `parent/action:${action.id}:${input.operationKey}`,
            eventId: "event",
            deliveryId: "delivery",
          },
        }));
      },
      project(kind, input) {
        assert.equal(kind, OWNER_CHILD_ACTION_RESULT);
        projections.push(pass(input));
        if (pending) {
          pending = false;
          return Promise.resolve({ status: "pending" });
        }
        return Promise.resolve(pass(result));
      },
    },
  });
  return { port, calls, projections };
}

test("child pure port keeps direct and encoded data parity and target-scoped local identity", async () => {
  for (const encoded of [false, true]) {
    const f = setup(encoded);
    assert.deepEqual(
      await f.port.call(reference, "child", { private: "input" }, "step"),
      { value: 7 },
    );
    assert.equal(f.calls[0].kind, OWNER_CHILD_ACTION_ADMISSION);
    assert.equal(
      f.calls[0].key,
      ownerChildActionKey("owner", "space", "parent", "fixture.child", "step"),
    );
    assert.deepEqual(f.calls[0].input, {
      parent: { ...reference, operationKey: "parent" },
      actionAlias: "child",
      operationKey: "step",
      input: { private: "input" },
    });
    assert.equal(f.projections.length, 2);
    await f.port.call(reference, "other", {}, "step");
    assert.notEqual(f.calls[0].key, f.calls[1].key);
  }
});

test("child pure port refuses unsupported options and invalid result envelopes", async () => {
  const f = setup();
  for (const option of ["metadata", "identity", "prepare"]) {
    await assert.rejects(
      f.port.call(reference, "child", {}, "step", { [option]: {} } as never),
      /unsupported/,
    );
  }
  assert.equal(f.calls.length, 0);
  for (
    const result of [{ status: "completed" }, {
      status: "completed",
      output: null,
      extra: true,
    }, { status: "failed", code: "secret-provider-message" }]
  ) {
    await assert.rejects(
      setup(false, result as unknown as OwnerJson).port.call(
        reference,
        "child",
        {},
        "step",
      ),
      errorCode("action_result_unavailable"),
    );
  }
  for (
    const [status, code] of [["failed", "action_failed"], [
      "failed",
      "action_not_completed",
    ], ["cancelled", "action_cancelled"]]
  ) {
    await assert.rejects(
      setup(false, { status, code }).port.call(reference, "child", {}, "step"),
      errorCode(code),
    );
  }
});

test("child pure port bounds saturation and hung transports without cancelling durable child state", async () => {
  let admitted = 0;
  let projected = 0;
  for (const hangAdmission of [false, true]) {
    const port = createOwnerChildActionPort({
      ownerId: "owner",
      namespace: "space",
      parentOperationKey: "parent",
      registry,
      maxWaitMs: 20,
      pollMs: 1,
      port: {
        executeInput() {
          admitted++;
          return hangAdmission ? new Promise(() => {}) : Promise.resolve({
            status: "committed",
            result: {
              namespace: "space",
              actionId: "fixture.child",
              executionId: "parent/action:fixture.child:step",
              eventId: "event",
              deliveryId: "delivery",
            },
          });
        },
        project() {
          projected++;
          return Promise.resolve({ status: "pending" });
        },
      },
    });
    await assert.rejects(
      port.call(reference, "child", {}, "step"),
      errorCode(
        hangAdmission ? "action_admission_unknown" : "action_wait_interrupted",
      ),
    );
  }
  assert.equal(admitted, 2);
  assert.ok(projected > 0);
});

test("child pure port propagates cancellation before dispatch and while waiting", async () => {
  const f = setup();
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await assert.rejects(
    f.port.call(reference, "child", {}, "step", { signal: controller.signal }),
    /caller stopped/,
  );
  assert.equal(f.calls.length, 0);
  const pending = new AbortController();
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    port: {
      executeInput() {
        pending.abort(new Error("after admission"));
        return new Promise(() => {});
      },
      project() {
        throw new Error("must not project");
      },
    },
  });
  await assert.rejects(
    port.call(reference, "child", {}, "step", { signal: pending.signal }),
    /after admission/,
  );
});

test("child pure port retains unresolved transport slots after a local timeout", async () => {
  let admitted = 0;
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 5,
    maxPendingCalls: 1,
    port: {
      executeInput() {
        admitted++;
        return new Promise(() => {});
      },
      project() {
        throw new Error("must not project");
      },
    },
  });
  await assert.rejects(
    port.call(reference, "child", {}, "step"),
    errorCode("action_admission_unknown"),
  );
  await assert.rejects(
    port.call(reference, "child", {}, "different"),
    errorCode("owner_admission_refused"),
  );
  assert.equal(admitted, 1);
  for (
    const options of [{ maxWaitMs: 60_001 }, { pollMs: 1_001 }, {
      maxPendingCalls: 129,
    }]
  ) {
    assert.throws(
      () =>
        createOwnerChildActionPort({
          ownerId: "owner",
          namespace: "space",
          parentOperationKey: "parent",
          registry,
          port: {
            executeInput() {
              throw new Error();
            },
            project() {
              throw new Error();
            },
          },
          ...options,
        }),
      /bounded timing/,
    );
  }
});

test("interrupted child admission stays unknown and only a known admission exposes a safe reference", async () => {
  const child = {
    namespace: "space",
    actionId: "fixture.child",
    executionId: "parent/action:fixture.child:step",
    eventId: "event",
    deliveryId: "child-delivery",
  };
  const logicalKey = ownerChildActionKey(
    "owner",
    "space",
    "parent",
    "fixture.child",
    "step",
  );
  let late!: (value: { status: "committed"; result: typeof child }) => void;
  const commands: OwnerInputCommand[] = [];
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 10,
    maxPendingCalls: 1,
    port: {
      executeInput(command) {
        commands.push(command);
        return commands.length === 1
          ? new Promise((resolve) => {
            late = resolve;
          })
          : Promise.resolve({ status: "duplicate", result: child });
      },
      project() {
        return Promise.resolve({ status: "completed", output: { done: true } });
      },
    },
  });
  await assert.rejects(
    port.call(reference, "child", {}, "step"),
    (error: unknown) => {
      const data = error as Record<string, unknown>;
      assert.equal(data.code, "action_admission_unknown");
      assert.equal(data.indeterminate, true);
      assert.equal(data.outcome, "unknown");
      assert.equal(data.logicalKey, logicalKey);
      assert.equal(data.actionAlias, "child");
      assert.equal(data.operationKey, "step");
      assert.equal(data.reference, undefined);
      assert.equal(data.admitted, undefined);
      return true;
    },
  );
  assert.equal(commands.length, 1);
  late({ status: "committed", result: child });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await port.call(reference, "child", {}, "step"), {
    done: true,
  });
  assert.equal(commands[0].key, commands[1].key);

  const waiting = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 5,
    port: {
      executeInput() {
        return Promise.resolve({ status: "committed", result: child });
      },
      project() {
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    waiting.call(reference, "child", {}, "step"),
    (error: unknown) => {
      const data = error as Record<string, unknown>;
      assert.equal(data.code, "action_wait_interrupted");
      assert.equal(data.admitted, true);
      assert.equal(data.indeterminate, undefined);
      assert.equal(data.logicalKey, logicalKey);
      assert.deepEqual(data.reference, child);
      return true;
    },
  );
  const malformed = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    port: {
      executeInput() {
        return Promise.resolve({
          status: "committed",
          result: { ...child, namespace: "foreign" },
        });
      },
      project() {
        throw new Error("never project");
      },
    },
  });
  await assert.rejects(
    malformed.call(reference, "child", {}, "step"),
    (error: unknown) => {
      assert.equal((error as { indeterminate: unknown }).indeterminate, true);
      return errorCode("action_admission_unknown")(error);
    },
  );
});

test("synchronous transport rejection on abort cannot erase interrupted admission uncertainty", async () => {
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 5,
    port: {
      executeInput(_command, options) {
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new Error("transport aborted")),
            { once: true },
          );
        });
      },
      project() {
        throw new Error("never project");
      },
    },
  });
  await assert.rejects(
    port.call(reference, "child", {}, "step"),
    (error: unknown) => {
      const data = error as Record<string, unknown>;
      assert.equal(data.code, "action_admission_unknown");
      assert.equal(data.indeterminate, true);
      assert.equal(
        data.logicalKey,
        ownerChildActionKey(
          "owner",
          "space",
          "parent",
          "fixture.child",
          "step",
        ),
      );
      assert.equal(data.reference, undefined);
      return true;
    },
  );
});
