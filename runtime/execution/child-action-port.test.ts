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
  parseOwnerChildActionParentReference,
  parseOwnerChildActionParentSelector,
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

test("named child port uses separate route, bound target and existing prepared-child identity", async () => {
  const calls: OwnerInputCommand[] = [];
  const transport = {
    executeInput(): Promise<never> {
      throw new Error("ordinary route must not run");
    },
    prepareInput(command: OwnerInputCommand) {
      assert.equal(this, transport);
      calls.push(structuredClone(command));
      return Promise.resolve({
        status: "committed" as const,
        result: {
          namespace: "space",
          actionId: "fixture.child",
          executionId:
            'parent/action:fixture.child:prepare:["context.note","named"]',
          eventId: "event",
          deliveryId: "delivery",
        },
      });
    },
    project: () =>
      Promise.resolve({ status: "completed", output: { value: 7 } }),
  };
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    port: transport,
  });
  transport.prepareInput = () => {
    throw new Error("replacement must not run");
  };
  assert.deepEqual(
    await port.prepare(reference, "child", {
      preparation: "context.note",
      recordId: "note",
      mode: "context",
    }, " named "),
    { value: 7 },
  );
  assert.deepEqual(calls, [{
    kind: "action.child-prepare",
    domain: "logical",
    key: JSON.stringify([
      "action.child-prepare",
      "owner",
      "space",
      "parent",
      "context.note",
      "named",
    ]),
    input: {
      parent: { ...reference, operationKey: "parent" },
      targetActionId: "fixture.child",
      preparation: "context.note",
      recordId: "note",
      hints: { mode: "context", renderer: "text" },
      operationKey: "named",
    },
  }]);
});

test("named child port refuses missing route or malformed returned target without ordinary fallback", async () => {
  const f = setup();
  await assert.rejects(
    f.port.prepare(reference, "child", {
      preparation: "context.note",
      recordId: "note",
      mode: "context",
    }, "key"),
    errorCode("action_prepare_unavailable"),
  );
  assert.equal(f.calls.length, 0);
  let projected = 0;
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    port: {
      executeInput: () => Promise.reject(new Error("No fallback")),
      prepareInput: () =>
        Promise.resolve({
          status: "committed",
          result: {
            namespace: "space",
            actionId: "fixture.other",
            executionId:
              'parent/action:fixture.other:prepare:["context.note","key"]',
            eventId: "event",
            deliveryId: "delivery",
          },
        }),
      project: () => {
        projected++;
        return Promise.resolve(null);
      },
    },
  });
  await assert.rejects(
    port.prepare(reference, "child", {
      preparation: "context.note",
      recordId: "note",
      mode: "context",
    }, "key"),
    errorCode("action_admission_unknown"),
  );
  assert.equal(projected, 0);
});

test("named admission timeout retains raw occupancy shared with ordinary children until actual settlement", async () => {
  let reject!: (error: unknown) => void;
  let started = 0;
  const pending = new Promise<never>((_resolve, fail) => reject = fail);
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    maxWaitMs: 20,
    maxPendingCalls: 1,
    port: {
      executeInput: () => {
        started++;
        return Promise.reject(new Error("ordinary refused"));
      },
      prepareInput: () => {
        started++;
        return pending;
      },
      project: () => Promise.resolve(null),
    },
  });
  await assert.rejects(
    port.prepare(reference, "child", {
      preparation: "context.note",
      recordId: "note",
      mode: "context",
    }, "key"),
    errorCode("action_admission_unknown"),
  );
  await assert.rejects(
    port.call(reference, "child", null, "other"),
    errorCode("owner_admission_refused"),
  );
  assert.equal(started, 1);
  reject(new Error("actual transport settled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    port.call(reference, "child", null, "other"),
    /ordinary refused/,
  );
  assert.equal(started, 2);
});

test("oversized composite preparation key cannot consume the shared child slot", async () => {
  let calls = 0;
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry: createPluginRegistry({
      actions: {
        child: defineAction({
          id: "fixture.child",
          execute: (x: unknown) => x,
        }),
      },
    }),
    maxPendingCalls: 1,
    maxWaitMs: 5,
    pollMs: 1,
    port: {
      executeInput() {
        calls++;
        return Promise.resolve({
          status: "committed",
          result: {
            namespace: "space",
            actionId: "fixture.child",
            executionId: "parent/action:fixture.child:valid",
            eventId: "event",
            deliveryId: "delivery",
          },
        });
      },
      prepareInput() {
        calls++;
        throw new Error("should not submit invalid key");
      },
      project() {
        return Promise.resolve({ status: "completed", output: "ok" });
      },
    },
  });
  const ref = {
    deliveryId: "parent-delivery",
    dispatchAttemptId: "parent-attempt",
  };
  await assert.rejects(
    port.prepare(ref, "child", {
      preparation: "p".repeat(600),
      recordId: "record",
      mode: "context",
    }, "k".repeat(600)),
  );
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await port.call(ref, "child", {}, "valid"), "ok");
});

test("child parent selectors are disjoint closed detached coordinates", () => {
  const worker = {
    deliveryId: "delivery",
    dispatchAttemptId: "worker-attempt",
  };
  const local = {
    placement: "owner-local" as const,
    deliveryId: "delivery",
    attemptId: "local-attempt",
  };
  for (const selector of [worker, local]) {
    assert.deepEqual(parseOwnerChildActionParentSelector(selector), selector);
    assert.deepEqual(
      parseOwnerChildActionParentReference({
        ...selector,
        operationKey: "parent",
      }),
      { ...selector, operationKey: "parent" },
    );
    assert.throws(() => parseOwnerChildActionParentReference(selector));
    assert.throws(() =>
      parseOwnerChildActionParentSelector({
        ...selector,
        operationKey: "parent",
      })
    );
  }
  const detached = parseOwnerChildActionParentSelector(local);
  local.attemptId = "changed";
  assert.equal("attemptId" in detached && detached.attemptId, "local-attempt");
  let accessed = 0;
  for (
    const invalid of [
      { ...worker, attemptId: "mixed" },
      { ...local, dispatchAttemptId: "mixed" },
      { ...worker, placement: undefined },
      { ...local, placement: "worker" },
      { deliveryId: "delivery", attemptId: "missing-placement" },
      { ...worker, dispatchAttemptId: undefined },
      { ...local, attemptId: " " },
      Object.create(worker),
      Object.assign([], worker),
      Object.defineProperty({ deliveryId: "delivery" }, "dispatchAttemptId", {
        enumerable: true,
        get() {
          accessed++;
          return "attempt";
        },
      }),
      { ...local, [Symbol("hidden")]: "extra" },
    ]
  ) assert.throws(() => parseOwnerChildActionParentSelector(invalid));
  assert.equal(accessed, 0);
});
test("local child selectors preserve the worker logical key without fake dispatch identity", async () => {
  const local = {
    placement: "owner-local" as const,
    deliveryId: "local-delivery",
    attemptId: "local-attempt",
  };
  const f = setup(true), worker = setup(true);
  assert.deepEqual(
    await f.port.call(local, "child", { ordinary: true }, "same"),
    { value: 7 },
  );
  await worker.port.call(reference, "child", { ordinary: true }, "same");
  assert.equal(f.calls[0].key, worker.calls[0].key);
  const expected = { ...local, operationKey: "parent" };
  assert.deepEqual(
    (f.calls[0].input as Record<string, OwnerJson>).parent,
    expected,
  );
  assert.deepEqual(
    (f.projections[0] as Record<string, OwnerJson>).parent,
    expected,
  );
  assert.equal(Object.hasOwn(expected, "dispatchAttemptId"), false);
});
test("local child selector refuses named preparation even when a preparation port exists", async () => {
  let called = 0;
  const port = createOwnerChildActionPort({
    ownerId: "owner",
    namespace: "space",
    parentOperationKey: "parent",
    registry,
    port: {
      executeInput() {
        called++;
        throw new Error("must not admit");
      },
      prepareInput() {
        called++;
        throw new Error("must not prepare");
      },
      project() {
        called++;
        throw new Error("must not project");
      },
    },
  });
  await assert.rejects(
    port.prepare(
      {
        placement: "owner-local",
        deliveryId: "delivery",
        attemptId: "attempt",
      } as never,
      "child",
      { preparation: "prepare", recordId: "one", mode: "context" },
      "step",
    ),
    errorCode("action_prepare_unavailable"),
  );
  assert.equal(called, 0);
});
