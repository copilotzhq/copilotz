import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type {
  ActionCallOptions,
  ActionContext,
  AnyActionDefinition,
} from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import type { OwnerCommand } from "../owner/boundary.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { runRegisteredActionInvocation } from "./registered-action-invocation.ts";
import type { RegisteredActionInvocation } from "./registered-invocation.ts";
import { createRegisteredActionWorker } from "./registered-worker.ts";

type Options = Parameters<typeof runRegisteredActionInvocation>[0];
const callAction = (context: ActionContext) =>
  context.actions.action as (
    input: unknown,
    options?: ActionCallOptions,
  ) => Promise<unknown>;
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
  } as const,
});
function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(
  action: AnyActionDefinition,
  overrides: Partial<Options> = {},
) {
  const commands: OwnerCommand[] = [];
  const children: unknown[] = [];
  const control = new AbortController();
  const exposed = new AbortController();
  let cancelled = false;
  const invocation: RegisteredActionInvocation = {
    actionId: action.id,
    ownerId: "owner",
    namespace: "space",
    databaseSchema: "public",
    input: { title: "ordinary" },
    invocation: {
      actionRunId: "run",
      rootKey: "root",
      operationKey: "run",
      metadata: {},
      identity: { causationId: "source" },
    },
  };
  const registry = createPluginRegistry({
    actions: { action },
    collections: { notes },
  });
  const options: Options = {
    registry,
    invocation,
    lifetime: {
      check() {
        if (cancelled) throw new Error("action_cancelled");
      },
      isCancelled: () => cancelled,
      commandSignal: control.signal,
      exposedSignal: exposed.signal,
    },
    calls: {
      execute(command) {
        commands.push(structuredClone(command));
        return Promise.resolve({ status: "committed", result: null });
      },
      invokeAction(input) {
        children.push(structuredClone(input));
        return Promise.resolve(null);
      },
    },
    createCapabilities: () => ({
      resources: { fixture: { greeting: "hello" } },
      adapters: { fixture: { finish: (value: string) => `${value}!` } },
    }),
    ...overrides,
  };
  return {
    options,
    registry,
    commands,
    children,
    invocation,
    exposed,
    run: () => runRegisteredActionInvocation(options),
    cancel() {
      cancelled = true;
      control.abort();
      exposed.abort();
    },
  };
}

test("neutral Action and worker preserve ordinary context, generated IDs and local transaction values", async () => {
  const action = defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      const value = await ctx.transaction(async ({ collections }) => {
        const row = await collections.notes.create({ title: "ordinary" });
        const result: {
          id: string;
          map: Map<string, number>;
          fn(): number;
          self?: unknown;
        } = { id: row.id, map: new Map([["value", 7]]), fn: () => 8 };
        result.self = result;
        return result;
      }, { operationKey: "write" });
      assert.equal(value.self, value);
      assert.equal(value.fn(), 8);
      assert.equal(value.map.get("value"), 7);
      return {
        id: value.id,
        message: (ctx.adapters.fixture.finish as (value: string) => string)(
          String(ctx.resources.fixture.greeting),
        ),
      };
    },
  });
  const neutral = fixture(action);
  const leased = fixture(action);
  const expected = await neutral.run();
  const reference = {
    executionId: "run",
    deliveryId: "delivery",
    dispatchAttemptId: "attempt",
  };
  const worker = createRegisteredActionWorker({
    registry: leased.registry,
    createCapabilities: leased.options.createCapabilities,
    owner: {
      claim: () => Promise.resolve({ status: "committed", result: reference }),
      project: () =>
        Promise.resolve({
          ...leased.invocation,
          workerId: "worker",
        }),
      complete: (_reference, completion) =>
        Promise.resolve({
          status: "committed",
          result: { ...reference, status: completion.status },
        }),
      readCompletion: () => Promise.resolve(undefined),
      execute: leased.options.calls.execute,
    },
  });
  const actual = await worker.execute({
    assignmentId: "assignment",
    sessionId: "session",
  });
  assert.equal(actual.status, "executed");
  if (actual.status !== "executed") return;
  assert.deepEqual(actual.completion, expected);
  assert.deepEqual(leased.commands, neutral.commands);
});

test("neutral Action lifetime budget counts sequential settled child calls and closes retained callers", async () => {
  let retained!: ActionContext;
  const action = defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      retained = ctx;
      for (let i = 0; i < 100; i++) await callAction(ctx)(null);
      try {
        await callAction(ctx)(null);
      } catch { /* refusal stays latched */ }
      return "caught";
    },
  });
  const f = fixture(action);
  assert.deepEqual(await f.run(), {
    status: "failed",
    code: "action_capability_unsupported",
  });
  assert.equal(f.children.length, 100);
  assert.throws(() => callAction(retained)(null), /closed/);
});

for (const unknown of [false, true]) {
  test(`neutral Action drains a late ${unknown ? "unknown" : "known"} unawaited command failure`, async () => {
    const pending = gate<never>();
    const started = gate();
    let retained!: ActionContext;
    const f = fixture(
      defineAction({
        id: "action",
        execute(_input: unknown, ctx: ActionContext) {
          retained = ctx;
          void ctx.transaction(async ({ collections }) => {
            await collections.notes.create({ title: "late" });
          }, { operationKey: "late" });
          return "finished";
        },
      }),
      {
        calls: {
          execute() {
            started.resolve();
            return pending.promise;
          },
        },
      },
    );
    let finished = false;
    const result = f.run();
    void result.then(() => finished = true, () => finished = true);
    await started.promise;
    await Promise.resolve();
    assert.equal(finished, false);
    assert.throws(
      () => retained.transaction(() => {}, { operationKey: "closed" }),
      /closed/,
    );
    const error = Object.assign(
      new Error("late failure"),
      unknown ? { code: "owner_commit_unknown" } : {},
    );
    pending.reject(error);
    if (unknown) await assert.rejects(result, (actual) => actual === error);
    else {
      assert.deepEqual(await result, {
        status: "failed",
        code: "action_failed",
      });
    }
  });
}

test("neutral Action snapshot and selected execute survive capability preparation await", async () => {
  const ready = gate();
  const resume = gate();
  let receiver: unknown;
  const action = defineAction({
    id: "action",
    execute(input) {
      receiver = this;
      return input;
    },
  });
  const f = fixture(action, {
    async createCapabilities() {
      ready.resolve();
      await resume.promise;
      return { resources: {}, adapters: {} };
    },
  });
  const result = f.run();
  await ready.promise;
  (f.invocation.input as { title: string }).title = "mutated";
  (f.registry.actions.action as { execute: () => string }).execute = () =>
    "replacement";
  resume.resolve();
  assert.deepEqual(await result, {
    status: "completed",
    output: { title: "ordinary" },
  });
  assert.equal(receiver, action);
});

test("neutral Action private cancellation survives exposed signal tampering", async () => {
  const ready = gate();
  const resume = gate();
  let retained!: ActionContext;
  let executions = 0;
  const f = fixture(defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      retained = ctx;
      ready.resolve();
      await resume.promise;
      Object.defineProperty(ctx.signal, "aborted", { value: false });
      try {
        await ctx.transaction(() => {}, { operationKey: "late" });
      } catch { /* private check wins */ }
      executions++;
      return "late";
    },
  }));
  const result = f.run();
  await ready.promise;
  f.cancel();
  resume.resolve();
  assert.deepEqual(await result, {
    status: "cancelled",
    code: "action_cancelled",
  });
  assert.equal(executions, 1);
  assert.equal(f.commands.length, 0);
  assert.throws(() => callAction(retained)(null), /cancelled/);
});

test("neutral Action child calls receive only normalized ordinary arguments", async () => {
  const f = fixture(defineAction({
    id: "action",
    async execute(_input: unknown, ctx: ActionContext) {
      await callAction(ctx)({ x: 1 }, { operationKey: " explicit " });
      await callAction(ctx)(null);
      return null;
    },
  }));
  assert.equal((await f.run()).status, "completed");
  assert.deepEqual(f.children, [{
    actionAlias: "action",
    input: { x: 1 },
    operationKey: "explicit",
  }, { actionAlias: "action", input: null, operationKey: "1" }]);
});

test("neutral Action captures reconcile before capability-await and completes recovery before execute", async () => {
  const ready = gate();
  const resume = gate();
  const settlement = gate();
  const settlementStarted = gate();
  let confirmed = false;
  let executed = 0;
  let reconciled = 0;
  const reference = { namespace: "space", actionRunId: "run", step: "send" };
  const action = defineAction({
    id: "action",
    execute() {
      executed++;
      return "finished";
    },
    reconcile() {
      reconciled++;
      return { status: "confirmed" as const, outcome: "recovered" };
    },
  });
  const f = fixture(action, {
    async createCapabilities() {
      ready.resolve();
      await resume.promise;
      return { resources: {}, adapters: {} };
    },
    effects: {
      execute() {
        throw new Error("Recovery must not dispatch begin");
      },
      async settle() {
        settlementStarted.resolve();
        await settlement.promise;
        confirmed = true;
        return {
          status: "committed",
          result: { ...reference, status: "confirmed", outcome: "recovered" },
        };
      },
      project() {
        return Promise.resolve(
          confirmed
            ? { ...reference, status: "confirmed", outcome: "recovered" }
            : { ...reference, status: "begun" },
        );
      },
    },
  });
  (f.invocation as { recovery: RegisteredActionInvocation["recovery"] })
    .recovery = {
      status: "eligible",
      effects: [{ step: "send", status: "begun" }],
    };
  const result = f.run();
  await ready.promise;
  (action as { reconcile: typeof action.reconcile }).reconcile = () => {
    throw new Error("replacement");
  };
  resume.resolve();
  await settlementStarted.promise;
  assert.equal(executed, 0);
  assert.equal(reconciled, 1);
  settlement.resolve();
  assert.deepEqual(await result, { status: "completed", output: "finished" });
  assert.equal(executed, 1);
});

test("Action worker prebinds owner execute before capability preparation awaits", async () => {
  const ready = gate();
  const resume = gate();
  const called: string[] = [];
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.transaction(async ({ collections }) => {
          await collections.notes.create({ title: "bound" });
        }, { operationKey: "write" });
        return null;
      },
    }),
    {
      async createCapabilities() {
        ready.resolve();
        await resume.promise;
        return { resources: {}, adapters: {} };
      },
    },
  );
  const reference = {
    executionId: "run",
    deliveryId: "delivery",
    dispatchAttemptId: "attempt",
  };
  const port: import("./registered-worker.ts").RegisteredOwnerExecutionPort = {
    claim: () => Promise.resolve({ status: "committed", result: reference }),
    project: () => Promise.resolve({ ...f.invocation, workerId: "worker" }),
    complete: (_reference, completion) =>
      Promise.resolve({
        status: "committed",
        result: { ...reference, status: completion.status },
      }),
    readCompletion: () => Promise.resolve(undefined),
    execute(command, options) {
      assert.equal(this, port);
      called.push("original");
      return f.options.calls.execute(command, options);
    },
  };
  const worker = createRegisteredActionWorker({
    registry: f.registry,
    owner: port,
    createCapabilities: f.options.createCapabilities,
  });
  const result = worker.execute({
    assignmentId: "assignment",
    sessionId: "session",
  });
  await ready.promise;
  (port as { execute: typeof port.execute }).execute = () => {
    called.push("replacement");
    return Promise.resolve({ status: "committed", result: null });
  };
  resume.resolve();
  assert.equal((await result).receipt.status, "completed");
  assert.deepEqual(called, ["original"]);
});

test("neutral Action named preparation is data-only, explicit-key and bound before capability awaits", async () => {
  const ready = gate(), resume = gate();
  const calls: unknown[] = [];
  const action = defineAction({
    id: "action",
    execute: (_input: unknown, ctx: ActionContext) =>
      ctx.actions.action.prepareNamed({
        preparation: "context.note",
        recordId: "note",
        mode: "context",
      }, { operationKey: " named " }),
  });
  const f = fixture(action, {
    async createCapabilities() {
      ready.resolve();
      await resume.promise;
      return { resources: {}, adapters: {} };
    },
  });
  const originalCalls = {
    ...f.options.calls,
    prepareAction(input: unknown) {
      assert.equal(this, originalCalls);
      calls.push(input);
      return Promise.resolve({ answer: 7 });
    },
  };
  const running = runRegisteredActionInvocation({
    ...f.options,
    calls: originalCalls,
  });
  await ready.promise;
  originalCalls.prepareAction = () => {
    throw new Error("replacement must not run");
  };
  resume.resolve();
  assert.deepEqual(await running, {
    status: "completed",
    output: { answer: 7 },
  });
  assert.deepEqual(calls, [{
    actionAlias: "action",
    preparation: "context.note",
    recordId: "note",
    mode: "context",
    operationKey: "named",
  }]);
});

test("neutral Action named calls latch missing capability, invalid requests and unknown outcomes", async () => {
  for (const mode of ["missing", "blank", "extra", "unknown"]) {
    let called = 0;
    const unknown = Object.assign(new Error("lost admission"), {
      code: "action_admission_unknown",
      outcome: "unknown",
      indeterminate: true,
    });
    const action = defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        try {
          await ctx.actions.action.prepareNamed({
            preparation: "context.note",
            recordId: "note",
            mode: "context",
            ...(mode === "extra" ? { ownerId: "forged" } : {}),
          }, { operationKey: mode === "blank" ? " " : "key" });
        } catch {
          /* A caught failure remains part of invocation settlement. */
        }
        return "must not succeed";
      },
    });
    const f = fixture(action);
    const calls = {
      ...f.options.calls,
      ...(mode === "missing" ? {} : {
        prepareAction: () => {
          called++;
          return Promise.reject(unknown);
        },
      }),
    };
    if (mode === "unknown") {
      await assert.rejects(
        runRegisteredActionInvocation({ ...f.options, calls }),
        (error) => error === unknown,
      );
    } else {assert.equal(
        (await runRegisteredActionInvocation({ ...f.options, calls })).status,
        "failed",
      );}
    assert.equal(called, mode === "unknown" ? 1 : 0);
  }
});

test("neutral Action unawaited named admission drains and captured caller closes privately", async () => {
  const started = gate(),
    finish = gate<import("../owner/boundary.ts").OwnerJson>();
  let saved: ActionContext["actions"][string]["prepareNamed"] | undefined;
  let called = 0, settled = false;
  const f = fixture(
    defineAction({
      id: "action",
      execute(_input: unknown, ctx: ActionContext) {
        saved = ctx.actions.action.prepareNamed;
        void saved({
          preparation: "context.note",
          recordId: "note",
          mode: "context",
        }, { operationKey: "key" });
        return null;
      },
    }),
  );
  const running = runRegisteredActionInvocation({
    ...f.options,
    calls: {
      ...f.options.calls,
      prepareAction() {
        called++;
        started.resolve();
        return finish.promise;
      },
    },
  }).then((value) => {
    settled = true;
    return value;
  });
  await started.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  finish.resolve(null);
  assert.equal((await running).status, "completed");
  assert.throws(
    () =>
      saved!(
        { preparation: "context.note", recordId: "note", mode: "context" },
        { operationKey: "late" },
      ),
    /context_closed/,
  );
  assert.equal(called, 1);
});

test("neutral named preparation cannot reopen a privately cancelled context through exposed signal mutation", async () => {
  const ready = gate(), resume = gate();
  let called = 0;
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        ready.resolve();
        await resume.promise;
        Object.defineProperty(ctx.signal, "aborted", { value: false });
        return await ctx.actions.action.prepareNamed({
          preparation: "context.note",
          recordId: "note",
          mode: "context",
        }, { operationKey: "key", signal: ctx.signal });
      },
    }),
  );
  const running = runRegisteredActionInvocation({
    ...f.options,
    calls: {
      ...f.options.calls,
      prepareAction() {
        called++;
        return Promise.resolve(null);
      },
    },
  });
  await ready.promise;
  f.cancel();
  resume.resolve();
  assert.deepEqual(await running, {
    status: "cancelled",
    code: "action_cancelled",
  });
  assert.equal(called, 0);
});

test("neutral Action reads capture capability before awaits and retain unawaited work", async () => {
  const response = gate<null>();
  const entered = gate();
  let reads = 0;
  const f = fixture(
    defineAction({
      id: "action",
      execute(_input: unknown, ctx: ActionContext) {
        void ctx.collections.notes.get({ id: "a" });
        entered.resolve();
        return "done";
      },
    }),
  );
  const calls = {
    ...f.options.calls,
    readCollection() {
      reads++;
      return response.promise;
    },
  };
  f.options = { ...f.options, calls };
  const pending = runRegisteredActionInvocation(f.options);
  calls.readCollection = () => {
    throw new Error("replacement callback");
  };
  await entered.promise;
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false);
  response.resolve(null);
  assert.deepEqual(await pending, { status: "completed", output: "done" });
  assert.equal(reads, 1);
});

test("neutral Action suppresses a read result after private cancellation", async () => {
  const response = gate<null>(), entered = gate();
  let disclosed = false;
  const f = fixture(
    defineAction({
      id: "action",
      async execute(_input: unknown, ctx: ActionContext) {
        try {
          await ctx.collections.notes.get({ id: "a" });
          disclosed = true;
        } catch { /* lifecycle still refuses */ }
        return "caught";
      },
    }),
  );
  const pending = runRegisteredActionInvocation({
    ...f.options,
    calls: {
      ...f.options.calls,
      readCollection() {
        entered.resolve();
        return response.promise;
      },
    },
  });
  await entered.promise;
  f.cancel();
  Object.defineProperty(f.exposed.signal, "aborted", { value: false });
  response.resolve(null);
  assert.equal((await pending).status, "cancelled");
  assert.equal(disclosed, false);
});
