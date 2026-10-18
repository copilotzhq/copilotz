import { streamFailureFixture } from "./stream-failure.fixture.ts";
/** Focused named-port tests. Real owner/transport acceptance is a separate fixture. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { deferAction } from "../actions/deferral.ts";
import type { ActionContext, AnyActionDefinition } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { defineView } from "../views/index.ts";
import type { OwnerCommand } from "../owner/boundary.ts";
import type {
  OwnerEffectPort,
  OwnerEffectRecord,
} from "../owner/effects-client.ts";
import {
  createRegisteredActionWorker,
  type RegisteredExecutionCompletion,
  type RegisteredExecutionProjection,
  type RegisteredExecutionReceipt,
  type RegisteredOwnerExecutionPort,
} from "./registered-worker.ts";

const hint = { assignmentId: "assignment", sessionId: "session" };
const ref = {
  executionId: "execution",
  deliveryId: "delivery",
  dispatchAttemptId: "attempt",
};
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
  } as const,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
const action = (
  execute: (input: unknown, ctx: ActionContext) => unknown,
): AnyActionDefinition => defineAction({ id: "fixture.action", execute });
function fixture(
  input: {
    action?: AnyActionDefinition;
    port?: Partial<RegisteredOwnerExecutionPort>;
    maxAssignments?: number;
  } = {},
) {
  const state = {
    claims: 0,
    projections: 0,
    capabilities: 0,
    executions: 0,
    reads: 0,
    persistenceOpens: 0,
    capabilitySignals: [] as AbortSignal[],
    receipt: undefined as RegisteredExecutionReceipt | undefined,
    commands: [] as OwnerCommand[],
    completions: [] as RegisteredExecutionCompletion[],
  };
  const registered = input.action ?? action(async (value, ctx) => {
    state.executions++;
    const local = await ctx.transaction(async ({ collections }) => {
      const created = await collections.notes.create({
        id: "note",
        title: String(value),
      });
      const result: {
        id: string;
        fn(): string;
        map: Map<string, number>;
        self?: unknown;
      } = {
        id: created.id,
        fn: () => "LOCAL_ONLY",
        map: new Map([["value", 7]]),
      };
      result.self = result;
      return result;
    }, { operationKey: "write" });
    assert.equal(local.self, local);
    assert.equal(local.fn(), "LOCAL_ONLY");
    assert.equal(local.map.get("value"), 7);
    const resource = ctx.resources.fixture.greet as (value: string) => string;
    const adapter = ctx.adapters.fixture.finish as (value: string) => string;
    return { id: local.id, message: adapter(resource(String(value))) };
  });
  const processor = defineProcessor({
    id: "fixture.processor",
    on: [{ eventType: "note.created" }],
    handle() {},
  });
  const view = defineView({
    id: "fixture.view",
    shows: { list: "note" },
    modes: ["context"],
    renderer: "text",
    render: () => "ordinary",
  });
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "whole-fixture",
      version: "1",
      actions: { action: registered },
      collections: { notes },
      processors: { processor },
      views: { view },
      resources: {
        fixture: { greet: (value: string) => `hello ${value}` },
        persistence: {
          open: () => {
            state.persistenceOpens++;
            throw new Error("worker must not open persistence");
          },
        },
      },
      adapters: { fixture: { finish: (value: string) => `${value}!` } },
    })],
  });
  const projection: {
    -readonly [K in keyof RegisteredExecutionProjection]:
      RegisteredExecutionProjection[K];
  } = {
    actionId: registered.id,
    input: "world",
    namespace: "space",
    databaseSchema: "owner-schema",
    ownerId: "owner",
    workerId: "worker",
    invocation: {
      actionRunId: "run",
      rootKey: "root",
      operationKey: "root/action",
      metadata: {},
      identity: { causationId: "source" },
    },
  };
  const port: RegisteredOwnerExecutionPort = {
    claim() {
      state.claims++;
      return Promise.resolve({ status: "committed", result: ref });
    },
    project() {
      state.projections++;
      return Promise.resolve(projection);
    },
    complete(reference, completion) {
      state.completions.push(structuredClone(completion));
      state.receipt = { ...reference, status: completion.status };
      return Promise.resolve({ status: "committed", result: state.receipt });
    },
    readCompletion() {
      state.reads++;
      return Promise.resolve(state.receipt);
    },
    execute(command) {
      state.commands.push(structuredClone(command));
      return Promise.resolve({
        status: "committed",
        result: { recordIds: ["note"], eventIds: ["event"] },
      });
    },
    ...input.port,
  };
  const worker = createRegisteredActionWorker({
    registry,
    owner: port,
    maxAssignments: input.maxAssignments,
    createCapabilities({ registry: actual, projection: copied, signal }) {
      state.capabilitySignals.push(signal);
      state.capabilities++;
      assert.equal(actual, registry);
      assert.equal(Object.keys(actual.processors).length, 1);
      assert.equal(Object.keys(actual.views).length, 1);
      // The capability factory receives a copy, not the worker's identity baseline.
      (copied.invocation as { operationKey: string }).operationKey = "poison";
      return {
        resources: { fixture: actual.resources.fixture },
        adapters: actual.adapters,
      };
    },
  });
  return { worker, state, port, registry, projection };
}

/** Deliberately named-port unit fixture. Owner SQL authority is tested separately. */
function effectPort(initial: "none" | "begun" = "none") {
  const reference = { namespace: "space", actionRunId: "run", step: "send" };
  let value: OwnerEffectRecord = { ...reference, status: initial };
  const stats = { begins: 0, settlements: 0 };
  const port: OwnerEffectPort = {
    execute(command) {
      assert.equal(command.kind, "effect.begin");
      assert.deepEqual(command.intent, reference);
      stats.begins++;
      const fresh = value.status === "none";
      if (fresh) value = { ...reference, status: "begun" };
      return Promise.resolve({
        status: fresh ? "committed" : "duplicate",
        result: { ...reference, status: "begun" },
      });
    },
    settle(command) {
      stats.settlements++;
      const intent = command.intent as Record<
        string,
        import("../owner/boundary.ts").OwnerJson
      >;
      value = command.kind === "effect.confirm"
        ? { ...reference, status: "confirmed", outcome: intent.outcome }
        : { ...reference, status: "not_started" };
      return Promise.resolve({
        status: "committed",
        result: structuredClone(value),
      });
    },
    project() {
      return Promise.resolve(structuredClone(value));
    },
  };
  return { port, stats };
}

test("registered Action ctx.effect sends only on fresh begin then replays its confirmed outcome", async () => {
  const effects = effectPort();
  let sends = 0;
  const f = fixture({
    port: { effects: effects.port },
    action: action(async (_input, ctx) => {
      const permission = await ctx.effect.begin("send");
      assert.equal(permission.status, "proceed");
      sends++;
      await ctx.effect.confirm("send", { providerReference: "safe" });
      const replay = await ctx.effect.begin("send");
      assert.equal(replay.status, "replay");
      return replay;
    }),
  });
  await f.worker.execute(hint);
  assert.equal(sends, 1);
  assert.deepEqual(f.state.completions, [{
    status: "completed",
    output: {
      status: "replay",
      outcome: { providerReference: "safe" },
    },
  }]);
});

test("registered Action declaration reconciles a begun step without another provider dispatch", async () => {
  const effects = effectPort("begun");
  let queries = 0;
  const f = fixture({
    port: { effects: effects.port },
    action: defineAction({
      id: "effect.action",
      async execute(_input: unknown, ctx: ActionContext) {
        const values = await Promise.all([
          ctx.effect.begin("send"),
          ctx.effect.begin("send"),
        ]);
        assert.ok(values.every((value) => value.status === "replay"));
        return values[0];
      },
      reconcile(step, ctx) {
        queries++;
        assert.equal(step, "send");
        assert.equal(ctx.action.runId, "run");
        return {
          status: "confirmed",
          outcome: { providerReference: "already-sent" },
        };
      },
    }),
  });
  await f.worker.execute(hint);
  assert.equal(queries, 1);
  assert.equal(effects.stats.settlements, 1);
  assert.equal(f.state.completions[0].status, "completed");
});

test("caught unavailable and indeterminate effect errors cannot become successful Action terminals", async () => {
  for (const available of [false, true]) {
    const effects = effectPort("begun");
    const f = fixture({
      port: available ? { effects: effects.port } : {},
      action: action(async (_input, ctx) => {
        await assert.rejects(async () => await ctx.effect.begin("send"), {
          code: available
            ? "effect_indeterminate"
            : "action_effect_unavailable",
        });
        return "must not complete";
      }),
    });
    await f.worker.execute(hint);
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: available
        ? "effect_indeterminate"
        : "action_capability_unsupported",
    }]);
  }
});

test("swallowed lost begin or confirm response leaves Action terminal unresolved", async () => {
  for (const operation of ["begin", "confirm"] as const) {
    const effects = effectPort();
    const unknown = Object.assign(new Error("lost"), { indeterminate: true });
    const port = {
      ...effects.port,
      [operation === "begin" ? "execute" : "settle"]: () =>
        Promise.reject(unknown),
    };
    const f = fixture({
      port: { effects: port },
      action: action(async (_input, ctx) => {
        try {
          await ctx.effect.begin("send");
          await ctx.effect.confirm("send", "safe");
        } catch {
          /* Business code cannot turn ambiguous mutation into success. */
        }
        return "caught";
      }),
    });
    await assert.rejects(f.worker.execute(hint), (error) => error === unknown);
    assert.deepEqual(f.state.completions, []);
  }
});

test("unawaited effect call drains before completion and captured capability closes afterwards", async () => {
  const effects = effectPort();
  const entered = deferred();
  const gate = deferred();
  let context!: ActionContext;
  const f = fixture({
    port: {
      effects: {
        ...effects.port,
        async settle(command, options) {
          entered.resolve();
          await gate.promise;
          return effects.port.settle(command, options);
        },
      },
    },
    action: action(async (_input, ctx) => {
      context = ctx;
      await ctx.effect.begin("send");
      void ctx.effect.confirm("send", "safe");
      return "ordinary";
    }),
  });
  const running = f.worker.execute(hint);
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.state.completions, []);
  gate.resolve();
  await running;
  await assert.rejects(async () => await context.effect.begin("send"), {
    code: "registered_worker_context_closed",
  });
  assert.equal(effects.stats.begins, 1);
});

test("private cancellation fences late reconciliation despite exposed signal tampering", async () => {
  const effects = effectPort("begun");
  const entered = deferred();
  const gate = deferred();
  const control = new AbortController();
  const f = fixture({
    port: { effects: effects.port },
    action: defineAction({
      id: "effect.cancel",
      execute(_input: unknown, ctx: ActionContext) {
        return ctx.effect.begin("send");
      },
      async reconcile(_step, ctx) {
        Object.defineProperty(ctx.signal, "aborted", { value: false });
        ctx.signal.dispatchEvent(new Event("abort"));
        entered.resolve();
        await gate.promise;
        return { status: "confirmed", outcome: "late" };
      },
    }),
  });
  const running = f.worker.execute(hint, { signal: control.signal });
  await entered.promise;
  control.abort();
  gate.resolve();
  await running;
  assert.equal(effects.stats.settlements, 0);
  assert.deepEqual(f.state.completions, [{
    status: "cancelled",
    code: "action_cancelled",
  }]);
});

test("unawaited settlement inside reconciliation stays in the private uncertainty drain", async () => {
  const effects = effectPort("begun");
  const gate = deferred();
  const entered = deferred();
  const unknown = Object.assign(new Error("lost nested settlement"), {
    indeterminate: true,
  });
  const f = fixture({
    port: {
      effects: {
        ...effects.port,
        async settle() {
          entered.resolve();
          await gate.promise;
          throw unknown;
        },
      },
    },
    action: defineAction({
      id: "effect.nested",
      async execute(_input: unknown, ctx: ActionContext) {
        try {
          await ctx.effect.begin("send");
        } catch { /* Must remain latched. */ }
        return "must not complete";
      },
      reconcile(step, ctx) {
        void ctx.effect.confirm(step, "safe");
        return { status: "indeterminate" };
      },
    }),
  });
  const running = f.worker.execute(hint);
  await entered.promise;
  assert.deepEqual(f.state.completions, []);
  gate.resolve();
  await assert.rejects(running, (error) => error === unknown);
  assert.deepEqual(f.state.completions, []);
});

test("whole-plugin registered Action uses selected Resources/Adapters and the shared planner without opening persistence", async () => {
  const f = fixture();
  const result = await f.worker.execute(hint);
  assert.equal(result.status, "executed");
  if (result.status !== "executed") assert.fail();
  assert.deepEqual(result.completion, {
    status: "completed",
    output: { id: "note", message: "hello world!" },
  });
  assert.equal(f.state.persistenceOpens, 0);
  assert.equal(f.state.executions, 1);
  assert.equal(f.state.capabilities, 1);
  assert.equal(f.state.commands[0].key, "root/action/write");
  assert.equal(JSON.stringify(f.state.commands).includes("LOCAL_ONLY"), false);
  assert.deepEqual(await f.worker.execute(hint), {
    status: "replayed",
    receipt: { ...ref, status: "completed" },
  });
  assert.equal(f.state.executions, 1);
  assert.equal(f.state.claims, 1);
  assert.equal(f.state.reads, 1);
});

test("same exact live assignment coalesces and no input projection or business code runs before claim resolves", async () => {
  const claimed = deferred();
  let claims = 0;
  const f = fixture({
    port: {
      async claim() {
        claims++;
        await claimed.promise;
        return { status: "committed", result: ref };
      },
    },
  });
  const first = f.worker.execute(hint);
  const second = f.worker.execute({ ...hint });
  assert.equal(first, second);
  assert.equal(claims, 1);
  assert.equal(f.state.projections, 0);
  assert.equal(f.state.capabilities, 0);
  assert.equal(f.state.executions, 0);
  claimed.resolve();
  await first;
  assert.equal(f.state.executions, 1);
});

test("duplicate claims only recover safe receipts and never hydrate or rerun active execution", async () => {
  const f = fixture({
    port: {
      claim: () => Promise.resolve({ status: "duplicate", result: ref }),
    },
  });
  f.state.receipt = { ...ref, status: "completed" };
  assert.deepEqual(await f.worker.execute(hint), {
    status: "replayed",
    receipt: f.state.receipt,
  });
  assert.equal(f.state.projections, 0);
  assert.equal(f.state.executions, 0);
  const active = fixture({
    port: {
      claim: () => Promise.resolve({ status: "duplicate", result: ref }),
    },
  });
  await assert.rejects(active.worker.execute(hint), {
    code: "registered_worker_replay_refused",
  });
  assert.equal(active.state.projections, 0);
  assert.equal(active.state.executions, 0);
});

for (const stage of ["claim", "complete", "execute"] as const) {
  test(`ambiguous ${stage} is latched without automatic retry or business-code reexecution`, async () => {
    const unknown = Object.assign(new Error("transport lost"), {
      indeterminate: true,
    });
    let calls = 0;
    const f = fixture({
      maxAssignments: 1,
      port: {
        [stage]: () => {
          calls++;
          return Promise.reject(unknown);
        },
      },
    });
    const first = f.worker.execute(hint);
    await assert.rejects(first, (error) => error === unknown);
    assert.equal(f.worker.execute(hint), first);
    await assert.rejects(f.worker.execute(hint), (error) => error === unknown);
    await assert.rejects(
      f.worker.execute({ ...hint, sessionId: "another-session" }),
      { code: "registered_worker_capacity" },
    );
    assert.equal(calls, 1);
    assert.equal(f.state.executions, stage === "claim" ? 0 : 1);
    assert.equal(f.state.completions.length, 0);
  });
}

test("completed local assignment reauthenticates receipt reads and never exposes cached output", async () => {
  let permitted = true;
  const f = fixture({
    port: {
      readCompletion() {
        if (!permitted) {
          return Promise.reject(new Error("receipt authorization revoked"));
        }
        return Promise.resolve({ ...ref, status: "completed" });
      },
    },
  });
  await f.worker.execute(hint);
  permitted = false;
  await assert.rejects(f.worker.execute(hint), /authorization revoked/);
  assert.equal(f.state.executions, 1);
  assert.equal(f.state.claims, 1);
});

test("input/output schema failures and thrown values submit only bounded code-only failure", async () => {
  let executed = false;
  const invalidInput = fixture({
    action: defineAction({
      id: "fixture.action",
      inputSchema: { type: "number" },
      execute() {
        executed = true;
        return null;
      },
    }),
  });
  await invalidInput.worker.execute(hint);
  assert.equal(executed, false);
  const invalidOutput = fixture({
    action: defineAction({
      id: "fixture.action",
      outputSchema: { type: "number" },
      execute() {
        return "private output";
      },
    }),
  });
  await invalidOutput.worker.execute(hint);
  const thrown = fixture({
    action: action(() => {
      throw new Error("SECRET_ERROR_TEXT");
    }),
  });
  await thrown.worker.execute(hint);
  for (const f of [invalidInput, invalidOutput, thrown]) {
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: "action_failed",
    }]);
  }
});

test("secret/content/resolve/stream/deferral Actions refuse unsupported lifecycle semantics", async () => {
  const definitions: AnyActionDefinition[] = [
    defineAction({
      id: "fixture.action",
      inputSchema: { type: "string", "x-copilotz-secret": true },
      execute: () => "secret",
    }),
    defineAction({
      id: "fixture.action",
      content: { input: ["body"] },
      execute: () => null,
    }),
    defineAction({
      id: "fixture.action",
      execute: () => null,
      resolve: () => null,
    }),
    action(() => new ReadableStream()),
    action(() => deferAction({ work: "not supported" })),
  ];
  for (const registered of definitions) {
    const f = fixture({ action: registered });
    await f.worker.execute(hint);
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: "action_capability_unsupported",
    }]);
  }
});

test("unsupported context calls fail explicitly even when caught; no captured planner capability survives completion", async () => {
  const capabilities = [
    (ctx: ActionContext) => ctx.readSnapshot(() => null),
    (ctx: ActionContext) => ctx.collections.notes.get({ id: "note" }),
    (ctx: ActionContext) =>
      (ctx.vectors as unknown as { query(): unknown }).query(),
    (ctx: ActionContext) => ctx.streams.open({} as never),
    (ctx: ActionContext) => ctx.content.get("asset"),
    (ctx: ActionContext) =>
      ctx.actions.nested.prepare(() => ({ input: null }), {
        operationKey: "nested",
      }),
    (ctx: ActionContext) => ctx.registerDeferredWait("wait"),
    (ctx: ActionContext) => ctx.progress("progress"),
    (ctx: ActionContext) =>
      ctx.transaction(({ relations }) =>
        (relations as unknown as { link(): unknown }).link()
      ),
  ];
  for (const call of capabilities) {
    const f = fixture({
      action: action(async (_value, ctx) => {
        try {
          await call(ctx);
        } catch { /* Unsupported does not become a supported run. */ }
        return null;
      }),
    });
    await f.worker.execute(hint);
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: "action_capability_unsupported",
    }]);
    assert.equal(f.state.commands.length, 0);
  }
  let retained!: ActionContext;
  const f = fixture({
    action: action((_value, ctx) => {
      retained = ctx;
      return null;
    }),
  });
  await f.worker.execute(hint);
  assert.throws(() => retained.transaction(() => null), {
    code: "registered_worker_context_closed",
  });
});

test("private cancellation survives instance-shadowing of the Action signal and settles only a safe cancellation", async () => {
  const abort = new AbortController();
  const f = fixture({
    action: action((_value, ctx) => {
      Object.defineProperty(ctx.signal, "aborted", { value: false });
      Object.defineProperty(ctx.signal, "throwIfAborted", { value() {} });
      abort.abort(new Error("PRIVATE_ABORT_REASON"));
      return "must not complete";
    }),
  });
  const result = await f.worker.execute(hint, { signal: abort.signal });
  assert.equal(result.status, "executed");
  assert.deepEqual(f.state.completions, [{
    status: "cancelled",
    code: "action_cancelled",
  }]);
});

for (const outcome of ["completed", "failed", "indeterminate"] as const) {
  test(`execution lifecycle signal closes on ${outcome} without cancelling safe completion`, async () => {
    let captured!: AbortSignal;
    let completed = false;
    const uncertain = Object.assign(new Error("unknown transaction"), {
      indeterminate: true,
    });
    const f = fixture({
      action: action(async (_value, ctx) => {
        captured = ctx.signal;
        assert.equal(captured.aborted, false);
        if (outcome === "failed") throw new Error("ordinary failure");
        if (outcome === "indeterminate") {
          await ctx.transaction(
            ({ collections }) => collections.notes.create({ id: "note" }),
            { operationKey: "write" },
          );
        }
        return null;
      }),
      port: {
        execute: () => Promise.reject(uncertain),
        complete(reference, completion, options) {
          completed = true;
          assert.equal(
            captured.aborted,
            true,
            "Action lifetime ends before terminal command",
          );
          assert.equal(
            options.signal?.aborted,
            false,
            "safe completion keeps its separate command signal",
          );
          return Promise.resolve({
            status: "committed",
            result: { ...reference, status: completion.status },
          });
        },
      },
    });
    if (outcome === "indeterminate") {
      await assert.rejects(
        f.worker.execute(hint),
        (error) => error === uncertain,
      );
      assert.equal(completed, false);
    } else await f.worker.execute(hint);
    assert.equal(captured.aborted, true);
    assert.equal(f.state.capabilitySignals[0].aborted, true);
  });
}

test("caught unsupported nested Collection command access still refuses the Action", async () => {
  const f = fixture({
    action: action((_value, ctx) => {
      try {
        ctx.collections.notes.commands.custom({ id: "note" });
      } catch { /* Nested unavailable access must latch the same refusal. */ }
      return null;
    }),
  });
  await f.worker.execute(hint);
  assert.deepEqual(f.state.completions, [{
    status: "failed",
    code: "action_capability_unsupported",
  }]);
  assert.equal(f.state.commands.length, 0);
});

test("completed assignments retain lifetime capacity and are never silently evicted", async () => {
  const f = fixture({ maxAssignments: 1 });
  await f.worker.execute(hint);
  await assert.rejects(f.worker.execute({ ...hint, assignmentId: "next" }), {
    code: "registered_worker_capacity",
  });
  assert.equal((await f.worker.execute(hint)).status, "replayed");
  assert.equal(f.state.executions, 1);
});

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function soon<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("heartbeat test timed out")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("worker lifetime waits for claim and explicit cancellation without renewal capability", async () => {
  const claim = deferred(), entered = deferred(), finish = deferred();
  const controller = new AbortController();
  const f = fixture({
    action: action(async (_input, ctx) => {
      entered.resolve();
      await finish.promise;
      assert.equal(ctx.signal.aborted, true);
      return "late";
    }),
    port: {
      async claim() {
        await claim.promise;
        return { status: "committed", result: ref };
      },
    },
  });
  const run = f.worker.execute(hint, { signal: controller.signal });
  await pause(20);
  assert.equal(f.state.capabilities, 0);
  claim.resolve();
  await soon(entered.promise);
  await pause(60);
  assert.equal(f.state.completions.length, 0);
  assert.equal(f.state.commands.length, 0, "waiting needs no renewal commands");
  controller.abort();
  finish.resolve();
  const result = await soon(run);
  assert.equal(result.receipt.status, "cancelled");
  assert.equal(f.state.completions.length, 1);
});

test("ordinary worker completes with no projection lease budget", async () => {
  const f = fixture({
    action: action(async () => {
      await pause(60);
      return "done";
    }),
  });
  assert.equal(Object.hasOwn(f.projection, "lease"), false);
  const result = await f.worker.execute(hint);
  assert.equal(result.receipt.status, "completed");
  assert.equal(f.state.commands.length, 0);
});

test("recovery preflight ambiguity refuses execute and terminal even for unawaited nested settlement", async () => {
  for (const unawaited of [false, true]) {
    const effects = effectPort("begun");
    const unknown = Object.assign(new Error("lost recovery confirmation"), {
      outcome: "unknown",
    });
    let executed = false;
    const f = fixture({
      port: {
        effects: { ...effects.port, settle: () => Promise.reject(unknown) },
      },
      action: defineAction({
        id: "fixture.action",
        execute: () => {
          executed = true;
          return null;
        },
        reconcile: (_step: string, ctx: ActionContext) => {
          if (unawaited) void ctx.effect.confirm("send", null).catch(() => {});
          return { status: "confirmed", outcome: null };
        },
      }) as AnyActionDefinition,
    });
    f.projection.recovery = {
      status: "eligible",
      effects: [{ step: "send", status: "begun" }],
    };
    await assert.rejects(f.worker.execute(hint), (error) => error === unknown);
    assert.equal(executed, false);
    assert.deepEqual(f.state.completions, []);
    assert.equal(effects.stats.begins, 0);
  }
});

test("blocked recovery refuses before capability creation and forged barrier payload fails closed", async () => {
  for (
    const barrier of [{ status: "blocked", effects: [] }, {
      status: "eligible",
      effects: [{ step: "send", status: "begun", outcome: "secret" }],
    }]
  ) {
    let executed = false;
    const f = fixture({
      action: action(() => {
        executed = true;
        return null;
      }),
    });
    f.projection.recovery = barrier as never;
    const result = await f.worker.execute(hint);
    assert.equal(result.status, "executed");
    if (result.status === "executed") {
      assert.equal(result.completion.status, "failed");
    }
    assert.equal(f.state.capabilities, 0);
    assert.equal(executed, false);
  }
});

test("registered Action child calls use exact durable parent and normalized local keys; known failures stay tracked", async () => {
  const calls: unknown[] = [];
  const f = fixture({
    action: action(async (_value, ctx) => {
      for (
        const operationKey of [
          " named ",
          undefined,
          "  ",
          "explicit",
          undefined,
        ]
      ) {
        try {
          await ctx.actions.action({ ordinary: true }, { operationKey });
        } catch { /* A settled child failure still prevents parent success. */ }
      }
      return null;
    }),
    port: {
      invokeAction(input) {
        calls.push(input);
        return Promise.reject(
          new Error(
            "Named child result is deliberately unavailable in this unit fixture.",
          ),
        );
      },
    },
  });
  f.projection.invocation = {
    ...f.projection.invocation,
    actionRunId: ref.executionId,
    operationKey: ref.executionId,
  };
  await f.worker.execute(hint);
  assert.deepEqual(
    calls,
    ["named", "1", "2", "explicit", "3"].map((operationKey) => ({
      reference: ref,
      actionAlias: "action",
      input: { ordinary: true },
      operationKey,
    })),
  );
  assert.deepEqual(f.state.completions, [{
    status: "failed",
    code: "action_failed",
  }]);
});

test("registered Action child capability refuses unsupported frame and overrides before dispatch", async () => {
  for (
    const mode of [
      "custom",
      "run",
      "metadata",
      "identity",
      "prepare",
      "property",
      "alias",
    ] as const
  ) {
    let calls = 0;
    const f = fixture({
      action: action(async (_value, ctx) => {
        try {
          if (mode === "prepare") {
            void ctx.actions.action.prepare;
          } else if (mode === "property") {
            void (ctx.actions.action as unknown as {
              missing: { nested: unknown };
            }).missing.nested;
          } else if (mode === "alias") {
            void (ctx.actions as unknown as { missing: { nested: unknown } })
              .missing.nested;
          } else {
            await ctx.actions.action(
              null,
              mode === "metadata"
                ? { metadata: {} }
                : mode === "identity"
                ? { identity: {} }
                : {},
            );
          }
        } catch { /* Unsupported access remains latched. */ }
        return null;
      }),
      port: {
        invokeAction() {
          calls++;
          return Promise.reject(
            new Error("Must not dispatch unsupported child invocation."),
          );
        },
      },
    });
    f.projection.invocation = {
      ...f.projection.invocation,
      actionRunId: mode === "run" ? "foreign-run" : ref.executionId,
      operationKey: mode === "custom" ? "custom-key" : ref.executionId,
    };
    await f.worker.execute(hint);
    assert.equal(calls, 0, mode);
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: "action_capability_unsupported",
    }], mode);
  }
});

for (const mode of ["caught", "unawaited"] as const) {
  test(`registered Action ${mode} uncertain child admission never writes a terminal or reruns`, async () => {
    const unknown = Object.assign(new Error("Interrupted child admission."), {
      code: "action_admission_unknown",
      outcome: "unknown",
      indeterminate: true,
    });
    let calls = 0;
    const f = fixture({
      action: action(async (_value, ctx) => {
        const pending = ctx.actions.action(null, { operationKey: "child" });
        if (mode === "caught") {
          try {
            await pending;
          } catch { /* Uncertainty cannot become success. */ }
        }
        return null;
      }),
      port: {
        invokeAction() {
          calls++;
          return Promise.reject(unknown);
        },
      },
    });
    f.projection.invocation = {
      ...f.projection.invocation,
      actionRunId: ref.executionId,
      operationKey: ref.executionId,
    };
    await assert.rejects(f.worker.execute(hint), (error) => error === unknown);
    await assert.rejects(f.worker.execute(hint), (error) => error === unknown);
    assert.equal(calls, 1);
    assert.deepEqual(f.state.completions, []);
  });
}

test("registered Action child caller closes with parent lifetime", async () => {
  let retained!: ActionContext;
  let calls = 0;
  const f = fixture({
    action: action((_value, ctx) => {
      retained = ctx;
      return null;
    }),
    port: {
      invokeAction() {
        calls++;
        return Promise.reject(new Error("No late child dispatch."));
      },
    },
  });
  f.projection.invocation = {
    ...f.projection.invocation,
    actionRunId: ref.executionId,
    operationKey: ref.executionId,
  };
  await f.worker.execute(hint);
  assert.throws(() => retained.actions.action(null), {
    code: "registered_worker_context_closed",
  });
  assert.equal(calls, 0);
});

test("direct Action effect ambiguity preserves only its fixed literal terminal code", async () => {
  for (
    const code of [
      "effect_indeterminate",
      ["effect_indeterminate"],
      "provider-secret-code",
      undefined,
    ]
  ) {
    const f = fixture({
      action: action(() => {
        throw Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), { code });
      }),
    });
    await f.worker.execute(hint);
    assert.deepEqual(f.state.completions, [{
      status: "failed",
      code: code === "effect_indeterminate"
        ? "effect_indeterminate"
        : "action_failed",
    }]);
  }
});

test("direct Action effect ambiguity retains unknown and cancellation precedence", async () => {
  for (const mode of ["unknown", "cancelled"] as const) {
    const signal = new AbortController();
    const error = Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), {
      code: "effect_indeterminate",
      ...(mode === "unknown" ? { outcome: "unknown" } : {}),
    });
    const f = fixture({
      action: action(() => {
        if (mode === "cancelled") signal.abort();
        throw error;
      }),
    });
    if (mode === "unknown") {
      await assert.rejects(f.worker.execute(hint), (value) => value === error);
      assert.deepEqual(f.state.completions, []);
    } else {
      await f.worker.execute(hint, { signal: signal.signal });
      assert.deepEqual(f.state.completions, [{
        status: "cancelled",
        code: "action_cancelled",
      }]);
    }
  }
});

test("registered Action named preparation binds exact live reference and refuses unsupported frame", async () => {
  for (const valid of [true, false]) {
    const calls: unknown[] = [];
    const f = fixture({
      action: action((_input, ctx) =>
        ctx.actions.action.prepareNamed({
          preparation: "context.note",
          recordId: "note",
          mode: "context",
        }, { operationKey: " named " })
      ),
      port: {
        prepareAction(input) {
          calls.push(input);
          return Promise.resolve({ answer: 7 });
        },
      },
    });
    if (valid) {
      f.projection.invocation = {
        ...f.projection.invocation,
        actionRunId: ref.executionId,
        operationKey: ref.executionId,
      };
    }
    const result = await f.worker.execute(hint);
    assert.equal(result.receipt.status, valid ? "completed" : "failed");
    assert.deepEqual(
      calls,
      valid
        ? [{
          reference: ref,
          actionAlias: "action",
          preparation: "context.note",
          recordId: "note",
          mode: "context",
          operationKey: "named",
        }]
        : [],
    );
  }
});

for (const unknown of [false, true, "hostile"] as const) {
  test(`worker Action background stream failure retains actual drain (unknown=${unknown})`, async () => {
    const stream = streamFailureFixture(unknown);
    const f = fixture({
      action: action((_input, ctx) => stream.handle(ctx)),
      port: { streams: stream.port },
    });
    let settled = false;
    const running = f.worker.execute(hint);
    void running.then(() => settled = true, () => settled = true);
    try {
      await stream.inspectBeforeRelease(() => settled);
      assert.equal(f.state.completions.length, 0);
      if (unknown) {
        await assert.rejects(running, (error) => error === stream.unknown);
        assert.equal(f.state.completions.length, 0);
      } else {
        assert.equal((await running).receipt.status, "failed");
        assert.equal(f.state.completions.length, 1);
      }
    } finally {
      stream.release();
    }
  });
}
