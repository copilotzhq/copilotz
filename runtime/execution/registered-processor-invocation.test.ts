import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionCallOptions, RuntimeContext } from "../actions/types.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { markNonRetryable } from "../failure.ts";
import type { OwnerCommand } from "../owner/boundary.ts";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import type { AnyProcessor } from "../plugins/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { RegisteredProcessorInvocation } from "./registered-invocation.ts";
import { runRegisteredProcessorInvocation } from "./registered-processor-invocation.ts";
import { createRegisteredProcessorWorker } from "./registered-processor.ts";

type Options = Parameters<typeof runRegisteredProcessorInvocation>[0];
const callChild = (context: ProcessorContext) =>
  context.actions.child as (
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
function fixture<P extends AnyProcessor>(
  processor: P,
  overrides: Partial<Options> = {},
) {
  const commands: OwnerCommand[] = [];
  const children: unknown[] = [];
  const control = new AbortController();
  const exposed = new AbortController();
  let cancelled = false;
  const invocation: RegisteredProcessorInvocation = {
    processorId: processor.id,
    ownerId: "owner",
    namespace: "space",
    databaseSchema: "public",
    deliveryId: "delivery",
    event: {
      id: "event",
      position: "1",
      schemaVersion: 1,
      createdAt: "2026-10-17T00:00:00.000Z",
      namespace: "space",
      type: "source",
      durable: true,
      correlationId: "correlation",
      data: { title: "ordinary" },
      metadata: {},
      payload: {},
    },
    attempts: 1,
    maxAttempts: 3,
    operationKey: "delivery:delivery",
    identity: { causationId: "event", correlationId: "correlation" },
  };
  const registry = createPluginRegistry({
    processors: { processor },
    collections: { notes },
    actions: { child: defineAction({ id: "child", execute: () => null }) },
  });
  const options: Options = {
    registry,
    invocation,
    lifetime: {
      check() {
        if (cancelled) throw new Error("processor_cancelled");
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
      resources: { fixture: { value: "resource" } },
      adapters: { fixture: { value: "adapter" } },
    }),
    ...overrides,
  };
  return {
    options,
    registry,
    invocation,
    commands,
    children,
    run: () => runRegisteredProcessorInvocation(options),
    cancel() {
      cancelled = true;
      control.abort();
      exposed.abort();
    },
  };
}
const processor = (
  handle: Processor["handle"],
  onError?: Processor["onError"],
) =>
  defineProcessor({
    id: "processor",
    on: [{ eventType: "source" }],
    handle,
    ...(onError ? { onError } : {}),
  });

test("neutral Processor and worker preserve direct Collections, event identity and local transaction values", async () => {
  let retained!: ProcessorContext;
  const definition = processor(async (event, ctx) => {
    retained = ctx;
    assert.equal(event.durable && event.id, "event");
    assert.deepEqual(ctx.identity, {
      causationId: "event",
      correlationId: "correlation",
    });
    assert.equal(ctx.operationKey, "delivery:delivery");
    assert.equal(ctx.resources.fixture.value, "resource");
    assert.equal(ctx.adapters.fixture.value, "adapter");
    await ctx.collections.notes.create({ title: "direct" });
    const local = await ctx.transaction(async ({ collections }) => {
      const row = await collections.notes.create({ title: "planned" });
      const result: {
        id: string;
        map: Map<string, number>;
        fn(): number;
        self?: unknown;
      } = { id: row.id, map: new Map([["value", 7]]), fn: () => 8 };
      result.self = result;
      return result;
    }, { operationKey: "write" });
    assert.equal(local.self, local);
    assert.equal(local.fn(), 8);
    assert.equal(local.map.get("value"), 7);
    await callChild(ctx)({ title: "child" }, { operationKey: " explicit " });
    await callChild(ctx)(null);
  });
  const neutral = fixture(definition);
  const leased = fixture(definition);
  const expected = await neutral.run();
  assert.throws(
    () => retained.collections.notes.create({ title: "late" }),
    /closed/,
  );
  const ref = { deliveryId: "delivery", dispatchAttemptId: "attempt" };
  const { deliveryId: _deliveryId, ...projection } = leased.invocation;
  const worker = createRegisteredProcessorWorker({
    registry: leased.registry,
    createCapabilities: leased.options.createCapabilities,
    owner: {
      claim: () => Promise.resolve({ status: "committed", result: ref }),
      project: () => Promise.resolve({ ...projection, workerId: "worker" }),
      complete: (_reference, completion) =>
        Promise.resolve({
          status: "committed",
          result: {
            ...ref,
            status: completion.status === "failed"
              ? "dead_letter"
              : completion.status,
          },
        }),
      readCompletion: () => Promise.resolve(undefined),
      execute: leased.options.calls.execute,
      invokeAction: ({ reference, ...input }, options) => {
        assert.deepEqual(reference, ref);
        return leased.options.calls.invokeAction!(input, options);
      },
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
  assert.deepEqual(leased.children, neutral.children);
  assert.deepEqual(neutral.children, [{
    actionAlias: "child",
    input: { title: "child" },
    operationKey: "explicit",
  }, { actionAlias: "child", input: null, operationKey: "1" }]);
});

for (const mode of ["retryable", "exhausted", "nonretryable"] as const) {
  test(`neutral Processor onError eligibility: ${mode}`, async () => {
    let onErrorCalls = 0;
    const error = mode === "nonretryable"
      ? markNonRetryable(new Error("known"))
      : new Error("known");
    const f = fixture(processor(() => {
      throw error;
    }, () => {
      onErrorCalls++;
      return true;
    }));
    if (mode === "exhausted") {
      (f.invocation as { attempts: number }).attempts = 3;
    }
    const result = await f.run();
    assert.equal(onErrorCalls, mode === "retryable" ? 0 : 1);
    assert.deepEqual(
      result,
      mode === "retryable"
        ? { status: "failed", code: "processor_failed", retryable: true }
        : { status: "succeeded" },
    );
  });
}

test("neutral Processor onError acknowledges exactly the awaited known failure", async () => {
  const error = markNonRetryable(new Error("known"));
  let onErrorCalls = 0;
  const f = fixture(processor(async (_event, ctx) => {
    await ctx.transaction(() => {
      throw error;
    }, { operationKey: "known" });
  }, (actual) => {
    assert.equal(actual, error);
    onErrorCalls++;
    return true;
  }));
  assert.deepEqual(await f.run(), { status: "succeeded" });
  assert.equal(onErrorCalls, 1);
  assert.equal(f.commands.length, 0);
});

for (const mode of ["independent", "new-same-error", "new-error"] as const) {
  test(`neutral Processor onError retains ${mode} tracked failure`, async () => {
    const error = markNonRetryable(new Error("acknowledged"));
    const other = markNonRetryable(new Error("other"));
    const f = fixture(processor(async (_event, ctx) => {
      if (mode === "independent") {
        void ctx.transaction(() => {
          throw other;
        }, { operationKey: "other" }).catch(() => {});
      }
      await ctx.transaction(() => {
        throw error;
      }, { operationKey: "known" });
    }, (_error, _event, ctx) => {
      if (mode !== "independent") {
        void ctx.transaction(() => {
          throw mode === "new-same-error" ? error : other;
        }, { operationKey: "new" }).catch(() => {});
      }
      return true;
    }));
    assert.deepEqual(await f.run(), {
      status: "failed",
      code: "processor_failed",
      retryable: false,
    });
  });
}

for (const mode of ["caught", "unawaited"] as const) {
  test(`neutral Processor ${mode} unknown failure bypasses onError`, async () => {
    const error = Object.assign(new Error("unknown"), {
      code: "owner_commit_unknown",
    });
    let onErrorCalls = 0;
    const f = fixture(
      processor(async (_event, ctx) => {
        const task = callChild(ctx)(null);
        if (mode === "caught") {
          try {
            await task;
          } catch { /* unknown stays latched */ }
        } else void task;
      }, () => {
        onErrorCalls++;
        return true;
      }),
      {
        calls: {
          execute: () => Promise.resolve({ status: "committed", result: null }),
          invokeAction: () => Promise.reject(error),
        },
      },
    );
    (f.invocation as { attempts: number }).attempts = 3;
    await assert.rejects(f.run(), (actual) => actual === error);
    assert.equal(onErrorCalls, 0);
  });
}

test("neutral Processor sequential settled calls exhaust lifetime budget and retained callers close", async () => {
  let retained!: ProcessorContext;
  const f = fixture(processor(async (_event, ctx) => {
    retained = ctx;
    for (let i = 0; i < 100; i++) await callChild(ctx)(null);
    try {
      await callChild(ctx)(null);
    } catch { /* refusal stays latched */ }
  }));
  assert.deepEqual(await f.run(), {
    status: "failed",
    code: "processor_capability_unsupported",
    retryable: false,
  });
  assert.equal(f.children.length, 100);
  assert.throws(() => callChild(retained)(null), /closed/);
});

test("neutral Processor waits for a late unawaited command and never invokes onError for it", async () => {
  const pending = gate<never>();
  const started = gate();
  let onErrorCalls = 0;
  let retained!: ProcessorContext;
  const f = fixture(
    processor((_event, ctx) => {
      retained = ctx;
      void ctx.collections.notes.create({ title: "late" });
    }, () => {
      onErrorCalls++;
      return true;
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
  const result = f.run();
  let done = false;
  void result.then(() => done = true, () => done = true);
  await started.promise;
  await Promise.resolve();
  assert.equal(done, false);
  assert.throws(
    () => retained.collections.notes.create({ title: "later" }),
    /closed/,
  );
  pending.reject(new Error("known"));
  assert.deepEqual(await result, {
    status: "failed",
    code: "processor_failed",
    retryable: true,
  });
  assert.equal(onErrorCalls, 0);
});

for (const mode of ["handle", "onError"] as const) {
  test(`neutral Processor snapshot and selected ${mode} survive capability preparation await`, async () => {
    const ready = gate();
    const resume = gate();
    let receiver: unknown;
    let seen: unknown;
    const definition = processor(function (this: unknown, event) {
      receiver = this;
      seen = event.data;
      if (mode === "onError") throw markNonRetryable(new Error("known"));
    }, function (this: unknown) {
      assert.equal(this, definition);
      return true;
    });
    const f = fixture(definition, {
      async createCapabilities() {
        ready.resolve();
        await resume.promise;
        return { resources: {}, adapters: {} };
      },
    });
    const result = f.run();
    await ready.promise;
    (f.invocation.event.data as { title: string }).title = "mutated";
    if (mode === "handle") {
      f.registry.processors.processor.handle = () => {
        throw new Error("replacement");
      };
    } else f.registry.processors.processor.onError = () => false;
    resume.resolve();
    assert.deepEqual(await result, { status: "succeeded" });
    assert.deepEqual(seen, { title: "ordinary" });
    assert.equal(receiver, definition);
  });
}

test("neutral Processor cancellation skips onError and fences tampered exposed signal", async () => {
  const ready = gate();
  const resume = gate();
  let onErrorCalls = 0;
  const f = fixture(processor(async (_event, ctx) => {
    ready.resolve();
    await resume.promise;
    Object.defineProperty(ctx.signal, "aborted", { value: false });
    await ctx.collections.notes.create({ title: "late" });
  }, () => {
    onErrorCalls++;
    return true;
  }));
  const result = f.run();
  await ready.promise;
  f.cancel();
  resume.resolve();
  assert.deepEqual(await result, {
    status: "cancelled",
    code: "processor_cancelled",
  });
  assert.equal(f.commands.length, 0);
  assert.equal(onErrorCalls, 0);
});

test("Processor worker prebinds owner execute before capability preparation awaits", async () => {
  const ready = gate();
  const resume = gate();
  const called: string[] = [];
  const f = fixture(
    processor(async (_event, ctx) => {
      await ctx.collections.notes.create({ title: "bound" });
    }),
    {
      async createCapabilities() {
        ready.resolve();
        await resume.promise;
        return { resources: {}, adapters: {} };
      },
    },
  );
  const reference = { deliveryId: "delivery", dispatchAttemptId: "attempt" };
  const { deliveryId: _deliveryId, ...projection } = f.invocation;
  const port: import("./registered-processor.ts").RegisteredProcessorOwnerPort =
    {
      claim: () => Promise.resolve({ status: "committed", result: reference }),
      project: () => Promise.resolve({ ...projection, workerId: "worker" }),
      complete: (_reference, completion) =>
        Promise.resolve({
          status: "committed",
          result: {
            ...reference,
            status: completion.status === "failed"
              ? "dead_letter"
              : completion.status,
          },
        }),
      readCompletion: () => Promise.resolve(undefined),
      execute(command, options) {
        assert.equal(this, port);
        called.push("original");
        return f.options.calls.execute(command, options);
      },
    };
  const worker = createRegisteredProcessorWorker({
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
  assert.equal((await result).receipt.status, "succeeded");
  assert.deepEqual(called, ["original"]);
});

test("neutral Processor refuses an already-revoked lifetime before capability construction", async () => {
  let capabilities = 0;
  let executions = 0;
  const f = fixture(
    processor(() => {
      executions++;
    }),
    {
      createCapabilities() {
        capabilities++;
        return { resources: {}, adapters: {} };
      },
    },
  );
  f.cancel();
  assert.deepEqual(await f.run(), {
    status: "cancelled",
    code: "processor_cancelled",
  });
  assert.equal(capabilities, 0);
  assert.equal(executions, 0);
});

test("neutral Processor named preparation retains data-only key and unknown failure", async () => {
  for (const unknown of [false, true]) {
    const calls: unknown[] = [];
    const error = Object.assign(new Error("lost"), {
      code: "action_admission_unknown",
      outcome: "unknown",
      indeterminate: true,
    });
    const f = fixture(
      defineProcessor({
        id: "processor",
        on: [{ eventType: "source" }],
        async handle(_event, ctx: RuntimeContext) {
          try {
            await ctx.actions.child.prepareNamed({
              preparation: "context.note",
              recordId: "note",
              mode: "context",
            }, { operationKey: " named " });
          } catch { /* unknown must remain pending */ }
        },
      }),
    );
    const running = runRegisteredProcessorInvocation({
      ...f.options,
      calls: {
        ...f.options.calls,
        prepareAction(input) {
          calls.push(input);
          return unknown ? Promise.reject(error) : Promise.resolve(null);
        },
      },
    });
    if (unknown) await assert.rejects(running, (value) => value === error);
    else assert.equal((await running).status, "succeeded");
    assert.deepEqual(calls, [{
      actionAlias: "child",
      preparation: "context.note",
      recordId: "note",
      mode: "context",
      operationKey: "named",
    }]);
  }
});

test("Processor worker prebinds named preparation and its exact reference before capability awaits", async () => {
  const ready = gate();
  const resume = gate();
  const called: string[] = [];
  const f = fixture(
    defineProcessor({
      id: "processor",
      on: [{ eventType: "source" }],
      async handle(_event, ctx: RuntimeContext) {
        await ctx.actions.child.prepareNamed({
          preparation: "context.note",
          recordId: "note",
          mode: "context",
        }, { operationKey: "named" });
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
  const reference = { deliveryId: "delivery", dispatchAttemptId: "attempt" };
  const { deliveryId: _deliveryId, ...projection } = f.invocation;
  const port: import("./registered-processor.ts").RegisteredProcessorOwnerPort =
    {
      claim: () => Promise.resolve({ status: "committed", result: reference }),
      project: () => Promise.resolve({ ...projection, workerId: "worker" }),
      complete: (_reference, completion) =>
        Promise.resolve({
          status: "committed",
          result: {
            ...reference,
            status: completion.status === "failed"
              ? "dead_letter"
              : completion.status,
          },
        }),
      readCompletion: () => Promise.resolve(undefined),
      execute: f.options.calls.execute,
      prepareAction(input) {
        assert.equal(this, port);
        assert.deepEqual(input, {
          reference,
          actionAlias: "child",
          preparation: "context.note",
          recordId: "note",
          mode: "context",
          operationKey: "named",
        });
        called.push("original");
        return Promise.resolve(null);
      },
    };
  const worker = createRegisteredProcessorWorker({
    registry: f.registry,
    owner: port,
    createCapabilities: f.options.createCapabilities,
  });
  const result = worker.execute({
    assignmentId: "assignment",
    sessionId: "session",
  });
  await ready.promise;
  Object.defineProperty(port, "prepareAction", {
    value: () => {
      called.push("replacement");
      return Promise.resolve(null);
    },
  });
  resume.resolve();
  assert.equal((await result).receipt.status, "succeeded");
  assert.deepEqual(called, ["original"]);
});
