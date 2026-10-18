import { streamFailureFixture } from "../testing/stream-failure.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import {
  defineProcessor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { OwnerLocalProcessorProjection } from "../owner/processor.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "../owner/placement-binding.ts";
import {
  createRegisteredLocalProcessorExecution,
  type RegisteredLocalProcessorOptions,
  type RegisteredLocalProcessorPort,
} from "./registered-local-processor.ts";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
function fixture(
  handle: (ctx: ProcessorContext) => void | Promise<void> = () => {},
  ports: Partial<RegisteredLocalProcessorPort> = {},
  ordinal = 1,
  withChild = false,
) {
  const reference: OwnerLocalProcessorAssignmentBinding = {
    placement: "owner-local",
    kind: "processor",
    ownerId: "owner",
    epoch: 7,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: "event",
    deliveryId: "delivery",
    processorId: "processor",
    consumerId: "processor:processor",
  };
  const projection: OwnerLocalProcessorProjection = {
    reference,
    processorId: "processor",
    ownerId: "owner",
    namespace: "space",
    databaseSchema: "public",
    deliveryId: "delivery",
    attempts: ordinal,
    maxAttempts: 3,
    operationKey: "delivery:delivery",
    identity: {
      causationId: "event",
      correlationId: "correlation",
      settlementScopeId: "scope",
    },
    event: {
      durable: true,
      id: "event",
      ownerId: "owner",
      position: "1",
      seq: "1",
      schemaVersion: 1,
      type: "source",
      namespace: "space",
      correlationId: "correlation",
      payload: {},
      metadata: {},
      data: {},
      createdAt: "2026-10-17T00:00:00.000Z",
    },
  };
  const events: string[] = [];
  const unknown: unknown[] = [];
  const state = { current: true, cancelled: false, executions: 0 };
  const registry = createPluginRegistry({
    ...(withChild
      ? {
        actions: { child: defineAction({ id: "child", execute: () => null }) },
      }
      : {}),
    processors: {
      processor: defineProcessor({
        id: "processor",
        on: [{ eventType: "source" }],
        handle(_event, ctx) {
          state.executions++;
          return handle(ctx);
        },
      }),
    },
  });
  const owner: RegisteredLocalProcessorPort = {
    start() {
      events.push("start");
      return Promise.resolve({
        status: "committed",
        result: { binding: structuredClone(reference), attempts: ordinal },
      });
    },
    project() {
      events.push("project");
      return Promise.resolve(structuredClone(projection));
    },
    execute() {
      events.push("execute");
      return Promise.resolve({ status: "committed", result: null });
    },
    sealInvocationCalls() {
      events.push("seal");
    },
    drainRawCalls() {
      events.push("drain");
      return Promise.resolve();
    },
    settlementState(options) {
      events.push("state");
      assert.equal(options?.signal, undefined);
      return Promise.resolve({
        reference: structuredClone(reference),
        cancellationRequested: state.cancelled,
      });
    },
    complete(completion, options) {
      events.push("complete");
      assert.equal(options?.signal, undefined);
      return Promise.resolve({
        status: "committed",
        result: {
          reference: structuredClone(reference),
          attempts: ordinal,
          ...(completion.status === "failed"
            ? {
              status: "retry_wait" as const,
              availableAt: "2026-10-17 00:00:00.123456+00",
            }
            : { status: completion.status }),
        },
      });
    },
    ...ports,
  };
  const options: RegisteredLocalProcessorOptions = {
    registry,
    reference,
    attemptOrdinal: ordinal,
    owner,
    createCapabilities: () => ({ resources: {}, adapters: {} }),
    isCurrent: () => state.current,
    onIndeterminate: (error) => {
      unknown.push(error);
    },
  };
  return {
    reference,
    projection,
    events,
    unknown,
    state,
    owner,
    options,
    create: () => createRegisteredLocalProcessorExecution(options),
  };
}

test("local Processor executes once after a fresh committed exact start and drains before quiescence", async () => {
  const f = fixture();
  const driver = f.create();
  const first = driver.run();
  assert.equal(driver.run(), first);
  const result = await first;
  await driver.quiescent;
  assert.equal(f.state.executions, 1);
  assert.equal(result.receipt.status, "succeeded");
  assert.deepEqual(f.events, [
    "start",
    "project",
    "seal",
    "drain",
    "state",
    "complete",
    "drain",
  ]);
});

test("duplicate start cannot restore an ended Processor attempt", async () => {
  const f = fixture();
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    owner: {
      ...f.owner,
      start: () =>
        Promise.resolve({
          status: "duplicate",
          result: { binding: f.reference, attempts: 1 },
        }),
    },
  });
  await assert.rejects(driver.run(), /indeterminate/);
  assert.equal(f.state.executions, 0);
  assert.equal(f.events.includes("project"), false);
  assert.equal(f.unknown.length, 1);
});

test("retry_wait ends exactly one attempt and retains microsecond timestamp bytes", async () => {
  const f = fixture(
    () => {
      throw new Error("business failure");
    },
    {},
    2,
  );
  const driver = f.create();
  const result = await driver.run();
  assert.equal(result.completion.status, "failed");
  assert.deepEqual(result.receipt, {
    reference: f.reference,
    attempts: 2,
    status: "retry_wait",
    availableAt: "2026-10-17 00:00:00.123456+00",
  });
  assert.equal(f.state.executions, 1);
  assert.equal(driver.run(), driver.run());
  await driver.quiescent;
});

test("retry_wait cannot exceed the projected attempt budget", async () => {
  const f = fixture(
    () => {
      throw new Error("business failure");
    },
    {},
    3,
  );
  await assert.rejects(f.create().run(), /indeterminate/);
  assert.equal(f.unknown.length, 1);
});

test("array receipt status and invalid retry timestamp are quarantined", async () => {
  for (
    const receipt of [
      { status: ["succeeded"] },
      { status: "retry_wait", availableAt: "later" },
      { status: "retry_wait", availableAt: "2026-02-30 00:00:00.123456+00" },
      { status: "retry_wait", availableAt: "2026-10-17 24:00:00.000001+00" },
      { status: "retry_wait", availableAt: "2025-02-29T00:00:00Z" },
    ]
  ) {
    const retry = typeof receipt.status === "string";
    const f = fixture(
      retry
        ? () => {
          throw new Error("retry");
        }
        : undefined,
    );
    const driver = createRegisteredLocalProcessorExecution({
      ...f.options,
      owner: {
        ...f.owner,
        complete: () =>
          Promise.resolve({
            status: "committed",
            result: {
              reference: f.reference,
              attempts: 1,
              ...receipt,
            },
          } as unknown as Awaited<
            ReturnType<RegisteredLocalProcessorPort["complete"]>
          >),
      },
    });
    await assert.rejects(driver.run(), /indeterminate/);
  }
});

test("incomplete durable event projection is quarantined before authored code", async () => {
  for (
    const mutate of [
      (p: OwnerLocalProcessorProjection) => {
        const copy = structuredClone(p);
        delete (copy.event as unknown as Record<string, unknown>).data;
        return copy;
      },
      (p: OwnerLocalProcessorProjection) =>
        ({
          ...p,
          event: { ...p.event, metadata: [] },
        }) as unknown as OwnerLocalProcessorProjection,
    ]
  ) {
    const f = fixture();
    const driver = createRegisteredLocalProcessorExecution({
      ...f.options,
      owner: {
        ...f.owner,
        project: () => Promise.resolve(mutate(f.projection)),
      },
    });
    await assert.rejects(driver.run(), /indeterminate/);
    assert.equal(f.state.executions, 0);
  }
});

test("complete durable subject retains the shared event type and id shape", async () => {
  const f = fixture();
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    owner: {
      ...f.owner,
      project: () =>
        Promise.resolve({
          ...f.projection,
          event: {
            ...f.projection.event,
            subject: { type: "note", id: "note-1" },
          },
        }),
    },
  });
  assert.equal((await driver.run()).receipt.status, "succeeded");
});

test("stale private authority after capability creation never executes authored code", async () => {
  const f = fixture();
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    createCapabilities() {
      f.state.current = false;
      return { resources: {}, adapters: {} };
    },
  });
  await assert.rejects(driver.run(), /authority_lost/);
  assert.equal(f.state.executions, 0);
  assert.equal(f.events.includes("complete"), false);
  f.state.current = true;
  await assert.rejects(driver.run(), /authority_lost/);
});

test("held factory is drained even after explicit revocation", async () => {
  const held = gate();
  const entered = gate();
  const f = fixture();
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    async createCapabilities() {
      entered.resolve();
      await held.promise;
      return { resources: {}, adapters: {} };
    },
  });
  const running = driver.run();
  const rejected = assert.rejects(running, /authority_lost/);
  await entered.promise;
  driver.revoke();
  let quiet = false;
  void driver.quiescent.then(() => {
    quiet = true;
  });
  await tick();
  assert.equal(quiet, false);
  held.resolve();
  await rejected;
  await driver.quiescent;
  assert.equal(f.state.executions, 0);
});

test("held raw drain prevents completion and quiescence", async () => {
  const held = gate();
  const entered = gate();
  const f = fixture(undefined, {
    async drainRawCalls() {
      entered.resolve();
      await held.promise;
    },
  });
  const driver = f.create();
  const running = driver.run();
  await entered.promise;
  assert.equal(f.events.includes("complete"), false);
  let quiet = false;
  void driver.quiescent.then(() => {
    quiet = true;
  });
  await tick();
  assert.equal(quiet, false);
  held.resolve();
  await running;
  await driver.quiescent;
});

test("failed drain quarantines without certifying quiescence or completion", async () => {
  const f = fixture(undefined, {
    drainRawCalls: () => Promise.reject(new Error("raw still running")),
  });
  const driver = f.create();
  await assert.rejects(driver.run(), /indeterminate/);
  let quiet = false;
  void driver.quiescent.then(() => {
    quiet = true;
  });
  await tick();
  assert.equal(quiet, false);
  assert.equal(f.events.includes("complete"), false);
});

test("current cancellation settles separately without the aborted invocation signal", async () => {
  const held = gate();
  const entered = gate();
  const f = fixture(async () => {
    entered.resolve();
    await held.promise;
  });
  const driver = f.create();
  const running = driver.run();
  await entered.promise;
  f.state.cancelled = true;
  driver.cancelCommitted();
  held.resolve();
  const result = await running;
  assert.equal(result.completion.status, "cancelled");
  assert.equal(result.receipt.status, "cancelled");
});

test("unconfirmed cancellation cannot manufacture a cancelled receipt", async () => {
  const f = fixture();
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    createCapabilities() {
      driver.cancelCommitted();
      return { resources: {}, adapters: {} };
    },
  });
  await assert.rejects(driver.run(), /cancellation_unconfirmed/);
  assert.equal(f.events.includes("complete"), false);
});

test("malformed start and projection identities refuse before capabilities", async () => {
  for (
    const mutate of [
      (p: OwnerLocalProcessorProjection) => ({ ...p, attempts: 2 }),
      (p: OwnerLocalProcessorProjection) => ({
        ...p,
        event: { ...p.event, ownerId: "other" },
      }),
      (p: OwnerLocalProcessorProjection) => ({
        ...p,
        identity: { ...p.identity, correlationId: "other" },
      }),
    ]
  ) {
    const f = fixture();
    const driver = createRegisteredLocalProcessorExecution({
      ...f.options,
      owner: {
        ...f.owner,
        project: () => Promise.resolve(mutate(f.projection)),
      },
    });
    await assert.rejects(driver.run(), /indeterminate/);
    assert.equal(f.state.executions, 0);
  }
});

test("known noncommit does not retry completion or activate a successor", async () => {
  const f = fixture();
  let completes = 0;
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    owner: {
      ...f.owner,
      complete: () => {
        completes++;
        return Promise.resolve({
          status: "not-committed",
          reference: f.reference,
        });
      },
    },
  });
  await assert.rejects(driver.run(), /completion_not_committed/);
  assert.equal(completes, 1);
  assert.equal(f.state.executions, 1);
});

test("lost terminal response is sticky unknown and never retried", async () => {
  const f = fixture();
  let completes = 0;
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    owner: {
      ...f.owner,
      complete: () => {
        completes++;
        return Promise.reject(new Error("reply lost"));
      },
    },
  });
  await assert.rejects(driver.run(), /indeterminate/);
  await assert.rejects(driver.run(), /indeterminate/);
  assert.equal(completes, 1);
  assert.equal(f.unknown.length, 1);
});

test("reentrant run captures its promise before trusted callbacks run", async () => {
  const f = fixture();
  let second: Promise<unknown> | undefined;
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    isCurrent() {
      second ??= driver.run();
      return true;
    },
  });
  const first = driver.run();
  await first;
  assert.equal(first, second);
  assert.equal(f.state.executions, 1);
});

test("retained exposed signal is aborted and ordinal must be a positive safe integer", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  const driver = createRegisteredLocalProcessorExecution({
    ...f.options,
    createCapabilities(input) {
      signal = input.signal;
      return { resources: {}, adapters: {} };
    },
  });
  await driver.run();
  assert.equal(signal?.aborted, true);
  for (const ordinal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        createRegisteredLocalProcessorExecution({
          ...f.options,
          attemptOrdinal: ordinal,
        }),
      /ordinal_invalid/,
    );
  }
});

test("local Processor forwards an ordinary child call through its captured bound port", async () => {
  let result: unknown;
  const calls: unknown[] = [];
  const f = fixture(
    async (ctx) => {
      const invoke = ctx.actions.child as (
        input: unknown,
        options: { operationKey: string },
      ) => Promise<unknown>;
      result = await invoke({ value: 1 }, { operationKey: "child" });
    },
    {
      invokeAction(input) {
        calls.push(input);
        return Promise.resolve({ value: 2 });
      },
    },
    1,
    true,
  );
  const driver = f.create();
  Object.assign(f.owner, {
    invokeAction: () => {
      throw new Error("replacement must not run");
    },
  });
  assert.equal((await driver.run()).receipt.status, "succeeded");
  assert.deepEqual(result, { value: 2 });
  assert.deepEqual(calls, [{
    actionAlias: "child",
    input: { value: 1 },
    operationKey: "child",
  }]);
});
test("local Processor child admission uncertainty cannot become a retry or terminal receipt", async () => {
  let calls = 0;
  const f = fixture(
    async (ctx) => {
      try {
        const invoke = ctx.actions.child as (
          input: unknown,
          options: { operationKey: string },
        ) => Promise<unknown>;
        await invoke(null, { operationKey: "child" });
      } catch { /* authored catch cannot settle unknown work */ }
    },
    {
      invokeAction() {
        calls++;
        return Promise.reject(
          Object.assign(new Error("unknown child admission"), {
            code: "action_admission_unknown",
            indeterminate: true,
          }),
        );
      },
    },
    1,
    true,
  );
  const driver = f.create();
  await assert.rejects(driver.run(), /indeterminate/);
  await assert.rejects(driver.run(), /indeterminate/);
  assert.equal(calls, 1);
  assert.equal(f.unknown.length, 1);
  assert.equal(f.events.includes("complete"), false);
});

test("local Processor named preparation captures its bound callback before execution", async () => {
  const requests: unknown[] = [];
  let result: unknown;
  const f = fixture(
    async (ctx) => {
      const child = ctx.actions
        .child as import("../actions/types.ts").RuntimeActionCallers[string];
      assert.equal(typeof child.prepareNamed, "function");
      result = await child.prepareNamed({
        preparation: "notes.context",
        recordId: "record",
        mode: "context",
      }, { operationKey: "named" });
    },
    {
      prepareAction(input) {
        requests.push(input);
        return Promise.resolve("prepared");
      },
    },
    1,
    true,
  );
  const driver = f.create();
  Object.assign(f.owner, {
    prepareAction() {
      throw new Error("replacement must not run");
    },
  });
  assert.equal((await driver.run()).receipt.status, "succeeded");
  assert.equal(result, "prepared");
  assert.deepEqual(requests, [{
    actionAlias: "child",
    preparation: "notes.context",
    recordId: "record",
    mode: "context",
    operationKey: "named",
  }]);
});

test("private Processor invocation signal closes before raw drain without cancelling settlement", async () => {
  const entered = gate(), release = gate();
  let hold = true;
  const f = fixture(() => {}, {
    async drainRawCalls() {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const driver = f.create();
  assert.equal(driver.invocationSignal.aborted, false);
  const running = driver.run();
  await entered.promise;
  assert.equal(driver.invocationSignal.aborted, true);
  assert.equal(f.state.current, true);
  assert.equal(f.events.includes("complete"), false);
  hold = false;
  release.resolve();
  const result = await running;
  assert.equal(result.receipt.status, "succeeded");
  await driver.quiescent;
});

for (const unknown of [false, true, "hostile"] as const) {
  test(`local Processor background stream failure retains actual drain (unknown=${unknown})`, async () => {
    const stream = streamFailureFixture(unknown);
    const f = fixture((ctx) => stream.handle(ctx), { streams: stream.port });
    const driver = f.create();
    let settled = false, quiescent = false;
    const running = driver.run();
    void running.then(() => settled = true, () => settled = true);
    void driver.quiescent.then(() => quiescent = true);
    try {
      await stream.inspectBeforeRelease(() => settled || quiescent);
      assert.equal(f.events.includes("complete"), false);
      if (unknown) {
        await assert.rejects(running, /local_processor_indeterminate/);
        assert.equal(f.events.includes("complete"), false);
        assert.equal(f.unknown.length, 1);
      } else {
        assert.equal((await running).receipt.status, "retry_wait");
        await driver.quiescent;
        assert.equal(
          f.events.filter((event) => event === "complete").length,
          1,
        );
      }
    } finally {
      stream.release();
    }
  });
}
