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
  const projection: RegisteredExecutionProjection = {
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
