import { streamFailureFixture } from "./stream-failure.fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type { ActionContext, AnyActionDefinition } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import type { OwnerCommand, OwnerJson } from "../owner/boundary.ts";
import type { OwnerLocalActionProjection } from "../owner/execution.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { runRegisteredActionInvocation } from "./registered-action-invocation.ts";
import type { RegisteredExecutionCompletion } from "./registered-invocation.ts";
import {
  createRegisteredLocalActionExecution,
  type RegisteredLocalActionCompletionOutcome,
  type RegisteredLocalActionOptions,
  type RegisteredLocalActionPort,
  type RegisteredLocalActionReference,
} from "./registered-local.ts";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
  } as const,
});
const ref = (): RegisteredLocalActionReference => ({
  placement: "owner-local",
  ownerId: "owner",
  epoch: 7,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
  kind: "action",
  actionId: "action",
  actionRunId: "run",
});
function fixture(
  action: AnyActionDefinition = defineAction({
    id: "action",
    execute: () => ({ ok: true }),
  }),
  ownerOverrides: Partial<RegisteredLocalActionPort> = {},
  overrides: Partial<RegisteredLocalActionOptions> = {},
) {
  const reference = ref();
  const projection: OwnerLocalActionProjection = {
    reference,
    actionId: "action",
    input: { title: "ordinary" },
    namespace: "space",
    databaseSchema: "public",
    ownerId: "owner",
    invocation: {
      actionRunId: "run",
      rootKey: "root",
      operationKey: "run",
      metadata: { source: "original" },
      identity: {
        causationId: "source",
        correlationId: "correlation",
        settlementScopeId: "scope",
      },
    },
  };
  const events: string[] = [];
  const commands: OwnerCommand[] = [];
  const completions: RegisteredExecutionCompletion[] = [];
  const unknown: unknown[] = [];
  const signals: AbortSignal[] = [];
  const state = { current: true, cancellationRequested: false };
  const owner: RegisteredLocalActionPort = {
    start(options) {
      events.push("start");
      signals.push(options!.signal!);
      return Promise.resolve({
        status: "committed",
        result: { binding: structuredClone(reference), attempts: 1 },
      });
    },
    project() {
      events.push("project");
      return Promise.resolve(structuredClone(projection));
    },
    execute(command) {
      events.push("execute");
      commands.push(structuredClone(command));
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
        cancellationRequested: state.cancellationRequested,
      });
    },
    complete(completion, options) {
      events.push("complete");
      assert.equal(options?.signal, undefined);
      completions.push(completion);
      return Promise.resolve({
        status: "committed",
        result: {
          reference: structuredClone(reference),
          status: completion.status,
        },
      });
    },
    ...ownerOverrides,
  };
  const options: RegisteredLocalActionOptions = {
    registry: createPluginRegistry({
      actions: { action },
      collections: { notes },
    }),
    reference,
    owner,
    createCapabilities() {
      events.push("capabilities");
      return { resources: {}, adapters: {} };
    },
    isCurrent: () => state.current,
    onIndeterminate: (error) => unknown.push(error),
    ...overrides,
  };
  const execution = createRegisteredLocalActionExecution(options);
  return {
    execution,
    options,
    owner,
    reference,
    projection,
    events,
    commands,
    completions,
    unknown,
    signals,
    state,
  };
}

test("local fresh invocation is one-shot, bound and quiescent with no worker lifecycle", async () => {
  let count = 0;
  let retained!: ActionContext;
  const f = fixture(defineAction({
    id: "action",
    execute(input: unknown, ctx: ActionContext) {
      count++;
      retained = ctx;
      return input;
    },
  }));
  const first = f.execution.run();
  assert.equal(f.execution.run(), first);
  const result = await first;
  assert.equal(f.execution.run(), first);
  assert.equal(count, 1);
  assert.deepEqual(result, {
    status: "executed",
    completion: { status: "completed", output: f.projection.input },
    receipt: { reference: ref(), status: "completed" },
  });
  assert.deepEqual(f.events, [
    "start",
    "project",
    "capabilities",
    "seal",
    "drain",
    "state",
    "complete",
    "drain",
  ]);
  assert.equal(retained.signal.aborted, true);
  assert.notEqual(retained.signal, f.signals[0]);
  assert.throws(() => retained.transaction(() => null), /context_closed/);
  await f.execution.quiescent;
  assert.equal(f.unknown.length, 0);
});

test("local start publishes its promise before a reentrant port callback", async () => {
  const f = fixture(undefined, {
    start() {
      assert.equal(f.execution.run(), first);
      return Promise.resolve({
        status: "committed",
        result: { binding: ref(), attempts: 1 },
      });
    },
  });
  const first = f.execution.run();
  await first;
});

test("local start demands known fresh exact commit before input or capabilities", async () => {
  const invalid: unknown[] = [
    { status: "duplicate", result: { binding: ref(), attempts: 1 } },
    { status: "unknown", result: { binding: ref(), attempts: 1 } },
    { status: "committed", result: { binding: ref(), attempts: 2 } },
    { status: "committed", result: { binding: ref(), attempts: "1" } },
    {
      status: "committed",
      result: { binding: { ...ref(), extra: true }, attempts: 1 },
    },
    {
      status: "committed",
      result: { binding: ref(), attempts: 1 },
      extra: true,
    },
    ...Object.entries(ref()).map(([key, value]) => ({
      status: "committed",
      result: {
        binding: {
          ...ref(),
          [key]: typeof value === "number" ? value + 1 : `${value}-other`,
        },
        attempts: 1,
      },
    })),
  ];
  for (const value of invalid) {
    const f = fixture(undefined, {
      start: () => Promise.resolve(value as never),
    });
    const first = f.execution.run();
    await assert.rejects(first, /registered_local_indeterminate/);
    assert.equal(f.execution.run(), first);
    assert.equal(f.events.includes("project"), false);
    assert.equal(f.events.includes("capabilities"), false);
    assert.equal(f.completions.length, 0);
    assert.equal(f.unknown.length, 1);
    await f.execution.quiescent;
  }
});

test("local unknown or arbitrary thrown start quarantines and never retries", async () => {
  for (
    const error of [
      new Error("start rejected"),
      Object.assign(new Error("unknown"), { code: "owner_commit_unknown" }),
    ]
  ) {
    let starts = 0;
    const f = fixture(undefined, {
      start() {
        starts++;
        return Promise.reject(error);
      },
    });
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(starts, 1);
    assert.equal(f.unknown.length, 1);
    assert.equal(f.completions.length, 0);
  }
});

test("local rejects worker/recovery, mismatched and accessor projections before capabilities", async () => {
  const changes: ((value: OwnerLocalActionProjection) => unknown)[] = [
    (value) => ({ ...value, recovery: { status: "ready", effects: [] } }),
    (value) => ({
      ...value,
      workerId: "worker",
      lease: { remainingMs: 10, renewAfterMs: 5 },
    }),
    (value) => ({ ...value, ownerId: "other" }),
    (value) => ({ ...value, actionId: "other" }),
    (value) => ({ ...value, namespace: "other" }),
    (value) => ({ ...value, reference: { ...ref(), attemptId: "other" } }),
    (value) => ({
      ...value,
      invocation: { ...value.invocation, actionRunId: "other" },
    }),
    (value) => ({
      ...value,
      invocation: { ...value.invocation, operationKey: "other" },
    }),
    (value) => ({
      ...value,
      invocation: { ...value.invocation, metadata: [] },
    }),
    (value) => ({
      ...value,
      invocation: { ...value.invocation, identity: { workerId: "other" } },
    }),
    (value) =>
      Object.defineProperty({ ...value }, "input", {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      }),
  ];
  for (const change of changes) {
    const f = fixture(undefined, {
      project: () => Promise.resolve(change(f.projection) as never),
    });
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(f.events.includes("capabilities"), false);
    assert.equal(f.completions.length, 0);
    assert.equal(f.unknown.length, 1);
  }
});

test("local revocation after suspended projection or capability construction never enters business code", async () => {
  for (const pause of ["project", "capabilities"] as const) {
    const waiting = gate();
    const entered = gate();
    let calls = 0;
    const f = fixture(
      defineAction({
        id: "action",
        execute() {
          calls++;
          return null;
        },
      }),
      pause === "project"
        ? {
          async project() {
            entered.resolve();
            await waiting.promise;
            return f.projection;
          },
        }
        : {},
      pause === "capabilities"
        ? {
          async createCapabilities() {
            entered.resolve();
            await waiting.promise;
            return { resources: {}, adapters: {} };
          },
        }
        : {},
    );
    let quiet = false;
    void f.execution.quiescent.then(() => {
      quiet = true;
    });
    const running = f.execution.run();
    await entered.promise;
    f.state.current = false;
    await tick();
    assert.equal(quiet, false);
    waiting.resolve();
    await assert.rejects(running, /authority_lost/);
    await f.execution.quiescent;
    assert.equal(calls, 0);
    assert.equal(f.completions.length, 0);
    assert.equal(f.unknown.length, 0);
  }
});

test("local captures port methods and detached authority before suspension", async () => {
  const f = fixture(undefined, {}, {
    createCapabilities(input) {
      assert.deepEqual(input.reference, ref());
      (input.reference as { attemptId: string }).attemptId = "malicious";
      (input.invocation.invocation as { actionRunId: string }).actionRunId =
        "malicious";
      return { resources: {}, adapters: {} };
    },
  });
  // Mutation of the original options must not change the private expected tuple.
  (f.options.reference as { attemptId: string }).attemptId = "changed";
  // The fixture itself uses that original object as fake durable state; restore
  // its contents while replacing every method on the originally supplied port.
  (f.options.reference as { attemptId: string }).attemptId = "attempt";
  for (
    const name of [
      "start",
      "project",
      "complete",
      "settlementState",
      "drainRawCalls",
      "sealInvocationCalls",
    ] as const
  ) {
    (f.owner as unknown as Record<string, unknown>)[name] = () => {
      throw new Error("rebound");
    };
  }
  assert.deepEqual((await f.execution.run()).receipt.reference, ref());
});

test("local known business, capability and ctx-policy failures can use independent settlement", async () => {
  const failures = ["business", "capabilities", "project"] as const;
  for (const where of failures) {
    const f = fixture(
      defineAction({
        id: "action",
        execute() {
          if (where === "business") throw new Error("known");
          return null;
        },
      }),
      where === "project"
        ? {
          project: () =>
            Promise.reject(
              Object.assign(new Error("ctx denied"), {
                code: "ActionOwnershipLost",
              }),
            ),
        }
        : {},
      where === "capabilities"
        ? {
          createCapabilities() {
            throw new Error("known");
          },
        }
        : {},
    );
    const result = await f.execution.run();
    assert.deepEqual(result.completion, {
      status: "failed",
      code: "action_failed",
    });
    assert.equal(f.completions.length, 1);
    assert.equal(f.unknown.length, 0);
  }
});

test("local cancellation waits for cooperative kernel return and verifies durable state", async () => {
  const entered = gate();
  const release = gate();
  let exposed!: AbortSignal;
  const f = fixture(defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      exposed = ctx.signal;
      entered.resolve();
      await release.promise;
      return { ignored: true };
    },
  }));
  const running = f.execution.run();
  await entered.promise;
  f.state.cancellationRequested = true;
  f.execution.cancelCommitted();
  assert.equal(exposed.aborted, true);
  assert.equal(f.signals[0].aborted, true);
  await tick();
  assert.equal(f.completions.length, 0);
  release.resolve();
  assert.deepEqual((await running).completion, {
    status: "cancelled",
    code: "action_cancelled",
  });
});

test("local cancellation hint alone cannot manufacture cancelled terminal", async () => {
  const entered = gate();
  const release = gate();
  const f = fixture(defineAction({
    id: "action",
    async execute() {
      entered.resolve();
      await release.promise;
      return null;
    },
  }));
  const running = f.execution.run();
  await entered.promise;
  f.execution.cancelCommitted();
  release.resolve();
  await assert.rejects(running, /cancellation_unconfirmed/);
  assert.equal(f.completions.length, 0);
});

test("local cancellation discovered only at settlement supersedes normal output", async () => {
  const f = fixture();
  f.state.cancellationRequested = true;
  assert.deepEqual((await f.execution.run()).completion, {
    status: "cancelled",
    code: "action_cancelled",
  });
});

test("local cancellation race retries once only after exact noncommit and fresh state", async () => {
  const completions: RegisteredExecutionCompletion[] = [];
  const f = fixture(undefined, {
    complete(completion) {
      completions.push(completion);
      if (completions.length === 1) {
        f.state.cancellationRequested = true;
        return Promise.resolve({ status: "not-committed", reference: ref() });
      }
      return Promise.resolve({
        status: "duplicate",
        result: { reference: ref(), status: completion.status },
      });
    },
  });
  assert.equal((await f.execution.run()).receipt.status, "cancelled");
  assert.deepEqual(completions, [
    { status: "completed", output: { ok: true } },
    { status: "cancelled", code: "action_cancelled" },
  ]);
  assert.equal(f.events.filter((value) => value === "state").length, 2);
});

test("local noncommit without cancellation never retries; cancelled noncommit has no loop", async () => {
  for (const race of [false, true]) {
    let calls = 0;
    const f = fixture(undefined, {
      complete() {
        calls++;
        if (race) f.state.cancellationRequested = true;
        return Promise.resolve({ status: "not-committed", reference: ref() });
      },
    });
    await assert.rejects(f.execution.run(), /completion_not_committed/);
    assert.equal(calls, race ? 2 : 1);
    assert.equal(f.unknown.length, 0);
  }
});

test("local arbitrary completion errors and malformed witnesses never infer cancellation or retry", async () => {
  for (
    const value of [
      new Error("ActionOwnershipLost"),
      Object.assign(new Error("Scope cancellation takes precedence"), {
        code: "ActionOwnershipLost",
      }),
      Object.assign(new Error("unknown"), { code: "owner_commit_unknown" }),
      { status: "not-committed", reference: { ...ref(), attemptId: "other" } },
      { status: "not-committed", reference: ref(), extra: true },
      { status: "committed", result: { reference: ref(), status: "failed" } },
    ]
  ) {
    let calls = 0;
    const f = fixture(undefined, {
      complete() {
        calls++;
        f.state.cancellationRequested = true;
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value as RegisteredLocalActionCompletionOutcome);
      },
    });
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(calls, 1);
    assert.equal(f.events.filter((value) => value === "state").length, 1);
    assert.equal(f.unknown.length, 1);
  }
});

test("local malformed current settlement state fails closed without completion", async () => {
  for (
    const value of [
      {
        reference: { ...ref(), attemptId: "other" },
        cancellationRequested: true,
      },
      { reference: ref(), cancellationRequested: 1 },
      { reference: ref(), cancellationRequested: false, input: "not allowed" },
    ]
  ) {
    const f = fixture(undefined, {
      settlementState: () => Promise.resolve(value as never),
    });
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(f.completions.length, 0);
  }
});

test("local unknown caught child call stays quarantined until raw work actually drains", async () => {
  const raw = gate();
  const notified = gate();
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        try {
          await (ctx.actions.action as (input: unknown) => Promise<unknown>)(
            {},
          );
        } catch { /* Author catch cannot clear unknown. */ }
        return "not success";
      },
    }),
    {
      invokeAction: () =>
        Promise.reject(
          Object.assign(new Error("child wait timeout"), {
            outcome: "unknown",
          }),
        ),
      drainRawCalls: () => raw.promise,
    },
    {
      onIndeterminate: () => {
        notified.resolve();
      },
    },
  );
  let quiet = false;
  void f.execution.quiescent.then(() => {
    quiet = true;
  });
  const running = f.execution.run();
  await notified.promise;
  await tick();
  assert.equal(quiet, false);
  assert.equal(f.completions.length, 0);
  raw.resolve();
  await assert.rejects(running, /registered_local_indeterminate/);
  await f.execution.quiescent;
  assert.equal(f.completions.length, 0);
  assert.equal(f.execution.run(), running);
});

test("local raw-call drain precedes terminal and revocation never manufactures one", async () => {
  for (const revoke of [false, true]) {
    const raw = gate();
    const draining = gate();
    const f = fixture(undefined, {
      drainRawCalls() {
        draining.resolve();
        return raw.promise;
      },
    });
    const running = f.execution.run();
    await draining.promise;
    assert.equal(f.completions.length, 0);
    if (revoke) f.execution.revoke();
    raw.resolve();
    if (revoke) await assert.rejects(running, /authority_lost/);
    else await running;
    assert.equal(f.completions.length, revoke ? 0 : 1);
  }
});

test("local quiescence includes the final terminal raw-call drain", async () => {
  const raw = gate();
  const completed = gate();
  let terminal = false;
  const f = fixture(undefined, {
    complete(completion) {
      terminal = true;
      completed.resolve();
      return Promise.resolve({
        status: "committed",
        result: { reference: ref(), status: completion.status },
      });
    },
    drainRawCalls: () => terminal ? raw.promise : Promise.resolve(),
  });
  let quiet = false;
  let done = false;
  void f.execution.quiescent.then(() => {
    quiet = true;
  });
  const running = f.execution.run();
  void running.then(() => {
    done = true;
  });
  await completed.promise;
  await tick();
  assert.equal(quiet, false);
  assert.equal(done, false);
  raw.resolve();
  await running;
  await f.execution.quiescent;
});

test("local drain failure cannot establish quiescence or terminal success", async () => {
  const f = fixture(undefined, {
    drainRawCalls: () => Promise.reject(new Error("raw state unavailable")),
  });
  let quiet = false;
  void f.execution.quiescent.then(() => {
    quiet = true;
  });
  await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
  await tick();
  assert.equal(quiet, false);
  assert.equal(f.completions.length, 0);
  assert.equal(f.unknown.length, 1);
});

test("local revocation holds noncooperative authored work until actual return", async () => {
  const entered = gate();
  const release = gate();
  const f = fixture(defineAction({
    id: "action",
    async execute() {
      entered.resolve();
      await release.promise;
      return null;
    },
  }));
  let quiet = false;
  void f.execution.quiescent.then(() => {
    quiet = true;
  });
  const running = f.execution.run();
  await entered.promise;
  f.execution.revoke();
  await tick();
  assert.equal(quiet, false);
  assert.equal(f.completions.length, 0);
  release.resolve();
  await assert.rejects(running, /authority_lost/);
  await f.execution.quiescent;
  assert.equal(f.completions.length, 0);
});

test("local never-started revocation drains but never submits start", async () => {
  const f = fixture();
  f.execution.revoke();
  await f.execution.quiescent;
  await assert.rejects(f.execution.run(), /authority_lost/);
  assert.equal(f.events.includes("start"), false);
});

test("local shares exact neutral transaction keys, generated IDs and authored callback values", async () => {
  const action = defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      const value = await ctx.transaction(async ({ collections }) => {
        const row = await collections.notes.create({ title: "ordinary" });
        return { id: row.id, map: new Map([["value", 7]]), fn: () => 8 };
      }, { operationKey: "write" });
      assert.equal(value.map.get("value"), 7);
      assert.equal(value.fn(), 8);
      return { id: value.id };
    },
  });
  const local = fixture(action);
  const neutral = fixture(action);
  const { reference: _reference, ...invocation } = neutral.projection;
  const expected = await runRegisteredActionInvocation({
    registry: neutral.options.registry,
    invocation,
    lifetime: {
      check() {},
      isCancelled: () => false,
      commandSignal: new AbortController().signal,
      exposedSignal: new AbortController().signal,
    },
    calls: { execute: neutral.owner.execute },
    createCapabilities: () => ({ resources: {}, adapters: {} }),
  });
  assert.equal(expected.status, "completed");
  assert.deepEqual((await local.execution.run()).completion, expected);
  assert.equal(local.commands.length, 1);
  assert.deepEqual(local.commands, neutral.commands);
});

test("local unresolved effect never turns into a failed completion", async () => {
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.effect.begin("send");
        return null;
      },
    }),
    {
      effects: {
        execute: () =>
          Promise.resolve({
            status: "duplicate",
            result: {
              namespace: "space",
              actionRunId: "run",
              step: "send",
              status: "begun",
            },
          }),
        settle: () => {
          throw new Error("must not settle");
        },
        project: () =>
          Promise.resolve(
            {
              namespace: "space",
              actionRunId: "run",
              step: "send",
              status: "begun",
            } as OwnerJson,
          ),
      },
    },
  );
  await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
  assert.equal(f.completions.length, 0);
});

test("local projection requires immutable source causation and complete durable scope identity", async () => {
  const identities = [
    undefined,
    {},
    { causationId: "source", correlationId: "correlation" },
    { causationId: "source", settlementScopeId: "scope" },
    { correlationId: "correlation", settlementScopeId: "scope" },
    {
      causationId: "foreign-source",
      correlationId: "correlation",
      settlementScopeId: "scope",
    },
    {
      causationId: "source",
      correlationId: "correlation",
      settlementScopeId: "scope",
      deduplicationId: "injected",
    },
  ];
  for (const identity of identities) {
    const f = fixture(undefined, {
      project() {
        const projection = structuredClone(f.projection);
        const frame = projection.invocation as Record<string, unknown>;
        if (identity === undefined) delete frame.identity;
        else frame.identity = identity;
        return Promise.resolve(projection);
      },
    });
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(f.events.includes("capabilities"), false);
    assert.equal(f.completions.length, 0);
  }
});

test("local private-current callback requires literal true and revocation is irreversible", async () => {
  for (const current of [false, 1, "true", {}, undefined]) {
    const f = fixture(undefined, {}, { isCurrent: () => current as boolean });
    await assert.rejects(f.execution.run(), /authority_lost/);
    assert.equal(f.events.includes("start"), false);
    assert.equal(f.completions.length, 0);
  }
  const f = fixture();
  f.execution.revoke();
  f.state.current = true;
  await assert.rejects(f.execution.run(), /authority_lost/);
  assert.equal(f.events.includes("start"), false);
});

test("local rechecks exact lifetime after start and settlement-state awaits", async () => {
  for (const pause of ["start", "state"] as const) {
    const entered = gate();
    const release = gate();
    const f = fixture(
      undefined,
      pause === "start"
        ? {
          async start() {
            entered.resolve();
            await release.promise;
            return {
              status: "committed",
              result: { binding: ref(), attempts: 1 },
            };
          },
        }
        : {
          async settlementState() {
            entered.resolve();
            await release.promise;
            return { reference: ref(), cancellationRequested: true };
          },
        },
    );
    const running = f.execution.run();
    await entered.promise;
    f.state.current = false;
    release.resolve();
    await assert.rejects(running, /authority_lost/);
    assert.equal(f.completions.length, 0);
    if (pause === "start") assert.equal(f.events.includes("project"), false);
  }
});

test("local revocation after terminal reply does not publish success or rerun", async () => {
  const entered = gate();
  const release = gate();
  let knownTerminals = 0;
  const f = fixture(undefined, {
    async complete(completion) {
      entered.resolve();
      await release.promise;
      // Future host adapter retains this raw durable fact independently, even
      // when the driver's post-await private lifetime check must refuse it.
      knownTerminals++;
      return {
        status: "committed",
        result: { reference: ref(), status: completion.status },
      };
    },
  });
  const running = f.execution.run();
  await entered.promise;
  f.execution.revoke();
  release.resolve();
  await assert.rejects(running, /authority_lost/);
  await f.execution.quiescent;
  assert.equal(knownTerminals, 1);
  assert.equal(f.execution.run(), running);
  assert.equal(f.unknown.length, 0);
});

test("local unknown and malformed mutation outcomes stay unknown even when authored code catches", async () => {
  for (
    const outcome of [
      Object.assign(new Error("mutation unknown"), {
        code: "owner_commit_unknown",
      }),
      { status: "unknown", result: null },
      { status: "committed", result: null, extra: true },
    ]
  ) {
    const f = fixture(
      defineAction({
        id: "action",
        async execute(_input: unknown, ctx: ActionContext) {
          try {
            await ctx.transaction(async ({ collections }) => {
              await collections.notes.create({ title: "ordinary" });
            }, { operationKey: "write" });
          } catch { /* A catch does not certify the raw owner command. */ }
          return { ignored: true };
        },
      }),
      {
        execute: () =>
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome as never),
      },
    );
    await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
    assert.equal(f.completions.length, 0);
    assert.equal(f.unknown.length, 1);
  }
});

test("local revocation after a mutation await cannot be converted into failure terminal", async () => {
  const entered = gate();
  const release = gate();
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.transaction(async ({ collections }) => {
          await collections.notes.create({ title: "ordinary" });
        });
        return null;
      },
    }),
    {
      async execute() {
        entered.resolve();
        await release.promise;
        return { status: "committed", result: null };
      },
    },
  );
  const running = f.execution.run();
  await entered.promise;
  f.state.current = false;
  release.resolve();
  await assert.rejects(running, /authority_lost/);
  assert.equal(f.completions.length, 0);
});

test("local first raw drain failure remains unknown after a later successful drain", async () => {
  let drains = 0;
  const f = fixture(undefined, {
    drainRawCalls() {
      return ++drains === 1
        ? Promise.reject(new Error("unknown raw accounting"))
        : Promise.resolve();
    },
  });
  await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
  await f.execution.quiescent;
  assert.equal(f.completions.length, 0);
  assert.equal(f.unknown.length, 1);
  assert.equal(drains, 2);
});

test("local sealing failure cannot establish quiescence and is never retried", async () => {
  let seals = 0;
  const f = fixture(undefined, {
    sealInvocationCalls() {
      seals++;
      throw new Error("seal failed");
    },
  });
  let quiet = false;
  void f.execution.quiescent.then(() => {
    quiet = true;
  });
  await assert.rejects(f.execution.run(), /registered_local_indeterminate/);
  await tick();
  assert.equal(quiet, false);
  assert.equal(seals, 1);
  assert.equal(f.unknown.length, 1);
  assert.equal(f.completions.length, 0);
});

test("local exposed signal events cannot forge durable cancellation", async () => {
  const f = fixture(defineAction({
    id: "action",
    execute(_input: unknown, ctx: ActionContext) {
      ctx.signal.dispatchEvent(new Event("abort"));
      return { stillCurrent: true };
    },
  }));
  assert.deepEqual((await f.execution.run()).completion, {
    status: "completed",
    output: { stillCurrent: true },
  });
});

test("local throwing private-current checks latch authority loss across later true results", async () => {
  for (
    const stage of ["project", "capabilities", "business", "mutation"] as const
  ) {
    let throwNext = false;
    let checks = 0;
    let lastCheck = 0;
    const f = fixture(
      defineAction({
        id: "action",
        async execute(_input: unknown, ctx: ActionContext) {
          if (stage === "business") throwNext = true;
          if (stage === "mutation") {
            try {
              await ctx.transaction(async ({ collections }) => {
                await collections.notes.create({ title: "ordinary" });
              });
            } catch { /* A later true callback must not revive authority. */ }
          }
          return null;
        },
      }),
      {
        project() {
          if (stage === "project") throwNext = true;
          return Promise.resolve(f.projection);
        },
        execute() {
          throwNext = true;
          return Promise.resolve({ status: "committed", result: null });
        },
      },
      {
        createCapabilities() {
          if (stage === "capabilities") throwNext = true;
          return { resources: {}, adapters: {} };
        },
        isCurrent() {
          checks++;
          if (throwNext) {
            throwNext = false;
            lastCheck = checks;
            throw new Error("private authority unavailable");
          }
          return true;
        },
      },
    );
    await assert.rejects(f.execution.run(), /authority_lost/);
    assert.equal(f.completions.length, 0);
    assert.equal(checks, lastCheck);
    assert.equal(f.signals[0].aborted, true);
    assert.equal(f.unknown.length, 0);
    await f.execution.quiescent;
  }
});

test("local Action named preparation captures its bound callback before execution", async () => {
  const requests: unknown[] = [];
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        return await ctx.actions.action.prepareNamed({
          preparation: "notes.context",
          recordId: "record",
          mode: "context",
        }, { operationKey: "named" });
      },
    }),
    {
      prepareAction(input) {
        requests.push(input);
        return Promise.resolve("prepared");
      },
    },
  );
  Object.assign(f.owner, {
    prepareAction() {
      throw new Error("replacement must not run");
    },
  });
  assert.equal((await f.execution.run()).completion.status, "completed");
  assert.deepEqual(requests, [{
    actionAlias: "action",
    preparation: "notes.context",
    recordId: "record",
    mode: "context",
    operationKey: "named",
  }]);
});

test("private Action invocation signal closes before raw drain without cancelling settlement", async () => {
  const entered = gate(), release = gate();
  let hold = true;
  const f = fixture(undefined, {
    async drainRawCalls() {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  assert.equal(f.execution.invocationSignal.aborted, false);
  const running = f.execution.run();
  await entered.promise;
  assert.equal(f.execution.invocationSignal.aborted, true);
  assert.equal(f.state.current, true);
  assert.equal(f.completions.length, 0);
  hold = false;
  release.resolve();
  const result = await running;
  assert.equal(result.completion.status, "completed");
  await f.execution.quiescent;
});

for (const unknown of [false, true, "hostile"] as const) {
  test(`local Action background stream failure retains actual drain (unknown=${unknown})`, async () => {
    const stream = streamFailureFixture(unknown);
    const f = fixture(
      defineAction({
        id: "action",
        execute: (_input, ctx: ActionContext) => stream.handle(ctx),
      }),
      { streams: stream.port },
    );
    let settled = false, quiescent = false;
    const running = f.execution.run();
    void running.then(() => settled = true, () => settled = true);
    void f.execution.quiescent.then(() => quiescent = true);
    try {
      await stream.inspectBeforeRelease(() => settled || quiescent);
      assert.equal(f.completions.length, 0);
      if (unknown) {
        await assert.rejects(running, /registered_local_indeterminate/);
        assert.equal(f.completions.length, 0);
        assert.equal(f.unknown.length, 1);
      } else {
        assert.equal((await running).receipt.status, "failed");
        await f.execution.quiescent;
        assert.equal(f.completions.length, 1);
      }
    } finally {
      stream.release();
    }
  });
}
