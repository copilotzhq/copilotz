import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommandBoundary,
  type OwnerJson,
} from "../owner/boundary.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import {
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "../owner/assignments.ts";
import type { OwnerAssignmentBinding } from "../owner/assignments.ts";
import {
  createOwnerWorkerCallAdmission,
  type OwnerWorkerCallContext,
} from "../owner/connection.ts";
import {
  createOwnerDispatchBridge,
  type OwnerDispatchInput,
  type OwnerScheduledAssignment,
} from "./owner-dispatch.ts";

type Bridge = ReturnType<typeof createOwnerDispatchBridge>;
type Fence = OwnerWorkerCallContext["fence"];
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function within<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("fixture timeout")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
function stream(input: OwnerJson = null) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
      controller.close();
    },
  });
}
const fence: Fence = {
  identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
  connectionId: "connection",
  sessionGeneration: 1,
};
async function fixture(
  config: {
    maxAssignments?: number;
    maxWitnesses?: number;
    processor?: boolean;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    fence: structuredClone(fence),
    phase: "ready",
    control: true,
    policy: true,
    beforePolicy: undefined as undefined | (() => Promise<void>),
    afterTransaction: undefined as undefined | (() => Promise<void>),
    lookup: undefined as
      | undefined
      | ((key: string) => Promise<OwnerScheduledAssignment | undefined>),
    opened: 0,
    serial: 0,
    policyCalls: 0,
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const result = await db.transaction(run);
      const after = state.afterTransaction;
      state.afterTransaction = undefined;
      await after?.();
      return result;
    },
  };
  const scheduled = new Map<string, OwnerScheduledAssignment>();
  let owner: OwnerCommandBoundary;
  let currentHolderId = "holder";
  const bridge = createOwnerDispatchBridge({
    ownerId: "owner",
    schema: "public",
    hasProcessor: (id) => id === "observe",
    ...config,
    getOwnerAuthority: () => ({ boundary: owner, holderId: currentHolderId }),
    sessions: {
      assertCurrent(current) {
        assert.deepEqual(current, state.fence);
        return { phase: state.phase };
      },
    },
    resolveScheduled(key) {
      return state.lookup ? state.lookup(key) : scheduled.get(key);
    },
    async authorizeControl(_tx, _caller) {
      state.policyCalls++;
      await state.beforePolicy?.();
      if (!state.control) throw new Error("control policy denied");
    },
  });
  const create = (holderId: string) =>
    createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId,
      handlers: {
        ...bridge.assignmentHandlers,
        async seed(key, context) {
          const result = await createEventStore({
            session: db,
            ownerCommit: context.ownerCommit,
          }).commitMutation({
            transaction: context.tx,
            draft: {
              type: "requested",
              namespace: "space",
              payload: { secret: "input-only" },
              metadata: config.processor
                ? {}
                : { actionId: "work", actionRunId: String(key) },
              deduplicationId: String(key),
            },
            consumers: [{
              consumerId: config.processor
                ? "processor:observe"
                : "registered:work",
              settlement: "inherit",
            }],
          });
          return {
            namespace: "space",
            ...(config.processor
              ? { kind: "processor" as const, processorId: "observe" }
              : { actionId: "work", executionId: String(key) }),
            sourceEventId: result.event.id,
            deliveryId: result.deliveries[0].id,
          };
        },
      },
      projections: {
        async binding(_input, context) {
          return await bridge.resolveStarted(context.tx, context.caller) ??
            null;
        },
      },
      async authorize(tx, caller, command, time) {
        if (command.kind.startsWith("assignment.")) {
          await bridge.authorizeAssignment(tx, caller, command, time);
        } else if (command.kind === "seed") {
          if (caller.host !== true) {
            throw new Error("seed host only");
          }
        } else if (!state.policy || !await bridge.resolveStarted(tx, caller)) {
          throw new Error("business policy denied");
        }
      },
      authenticateReceipt() {
        throw new Error("fixture receipt access denied");
      },
    });
  owner = create("holder");
  await owner.acquire(0);
  async function seed(key: string) {
    const result = await owner.execute({
      principal: { kind: "worker" as const, workerId: "host" },
      ownerEpoch: owner.epoch!,
      host: true,
    }, { kind: "seed", domain: "logical", key, intent: key });
    const refs = result.result as OwnerScheduledAssignment;
    scheduled.set(key, refs);
    return refs;
  }
  await seed("one");
  await seed("two");
  const completions: ReturnType<typeof deferred<unknown>>[] = [];
  async function dispatch(
    key = "one",
    settings: {
      input?: Partial<OwnerDispatchInput>;
      failOpen?: boolean;
      beforeHook?: (input: OwnerDispatchInput) => void | Promise<void>;
      afterHook?: () => void | Promise<void>;
    } = {},
  ) {
    const operationId = `operation-${++state.serial}`;
    const streamId = `stream-${state.serial}`;
    let dispatched!: OwnerDispatchInput;
    const completion = deferred<unknown>();
    completions.push(completion);
    const handle = await bridge.dispatch(
      {
        async dispatch(input) {
          dispatched = input;
          await settings.beforeHook?.(input);
          await bridge.lifecycle.onWorkAssigned({
            operationId,
            workload: input.workload,
            metadata: input.metadata ?? {},
            signal: input.signal!,
            assignment: { fence: structuredClone(state.fence), streamId },
          });
          await settings.afterHook?.();
          if (settings.failOpen) throw new Error("Open failed");
          state.opened++;
          return {
            operationId,
            streamId,
            completed: completion.promise,
            cancel() {
              completion.resolve("cancelled");
              return Promise.resolve("cancelled");
            },
          };
        },
      },
      { workload: "action", ...settings.input },
      key,
    );
    const context = (
      signal = new AbortController().signal,
      extra: Partial<OwnerWorkerCallContext> = {},
    ): OwnerWorkerCallContext => ({
      workload: "copilotz.owner.project",
      metadata: { ownerId: "owner" },
      signal,
      fence: structuredClone(state.fence),
      parent: {
        operationId,
        streamId,
        workload: "action",
        metadata: dispatched.metadata!,
      },
      ...extra,
    });
    return { handle, completion, context, dispatched };
  }
  async function resolve(caller: OwnerCaller) {
    return await owner.project(caller, "binding", null);
  }
  async function rows() {
    return (await db.query<
      { binding: OwnerAssignmentBinding; retired: boolean }
    >("SELECT binding,retired FROM owner_assignments ORDER BY assignment_id"))
      .rows;
  }
  async function close() {
    state.beforePolicy = undefined;
    state.afterTransaction = undefined;
    state.control = true;
    for (const completion of completions) completion.resolve("closed");
    bridge.stop();
    await bridge.retryRetirements();
    owner.stop();
    await db.close();
  }
  return {
    db,
    bridge,
    state,
    scheduled,
    dispatch,
    resolve,
    rows,
    seed,
    close,
    get owner() {
      return owner;
    },
    replaceHolderIdentity(holderId: string) {
      currentHolderId = holderId;
    },
    async replaceOwner() {
      const old = owner;
      owner = create("successor");
      currentHolderId = "successor";
      await owner.acquire(old.epoch!);
      old.stop();
      return owner;
    },
  };
}
async function witness(
  f: Awaited<ReturnType<typeof fixture>>,
  context: OwnerWorkerCallContext,
) {
  let caller!: OwnerCaller;
  const admission = f.bridge.wrapWorkerCalls({
    admit(captured) {
      caller = f.bridge.resolveAssignment(captured, "owner")!.caller;
      return () => Promise.resolve(new Uint8Array([1]));
    },
  });
  const handler = await admission.admit(context);
  assert.ok(handler);
  return { caller, handler };
}

test("dispatch awaits durable bind before Open; reservation and onStart-shaped context grant nothing", async () => {
  const f = await fixture();
  try {
    const entered = deferred(), release = deferred();
    f.state.beforePolicy = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.dispatch();
    await within(entered.promise);
    assert.equal(f.state.opened, 0);
    assert.equal(f.bridge.snapshot().assignments, 1);
    release.resolve();
    const opened = await pending;
    assert.equal(f.state.opened, 1);
    const [row] = await f.rows();
    assert.equal(row.retired, false);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(f.scheduled.get("one")!).map(
          (key) => [key, row.binding[key as keyof OwnerAssignmentBinding]],
        ),
      ),
      f.scheduled.get("one"),
    );
    assert.equal(
      f.bridge.resolveAssignment(opened.context(), "owner"),
      undefined,
    );
    assert.equal("onStart" in f.bridge.lifecycle, false);
    const { workerId, ...callerBinding } = row.binding;
    await assert.rejects(
      f.resolve({
        ...callerBinding,
        principal: { kind: "worker", workerId },
        ownerEpoch: 1,
      }),
      /business policy denied/,
    );
    const call = await witness(f, opened.context());
    assert.deepEqual(await f.resolve(call.caller), row.binding);
    await call.handler({
      input: stream(),
      signal: new AbortController().signal,
    });
    assert.equal(f.bridge.snapshot().witnesses, 0);
    await assert.rejects(f.resolve(call.caller), /business policy denied/);
  } finally {
    await f.close();
  }
});

test("two concurrent host requests use their exact trusted scheduled facts; copied or forged markers cannot rebind", async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.dispatch("one", {
        input: { metadata: { actionId: "forged", sourceEventId: "foreign" } },
      }),
      f.dispatch("two"),
    ]);
    const rows = await f.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Set(
        rows.map((row) =>
          "executionId" in row.binding ? row.binding.executionId : undefined
        ),
      ),
      new Set(["one", "two"]),
    );
    assert.notEqual(
      a.dispatched.metadata?.copilotzOwnerDispatch,
      b.dispatched.metadata?.copilotzOwnerDispatch,
    );
    for (
      const metadata of [a.dispatched.metadata!, {
        copilotzOwnerDispatch: "forged",
      }]
    ) {
      await assert.rejects(
        f.bridge.lifecycle.onWorkAssigned({
          operationId: "copied",
          workload: "action",
          metadata,
          signal: new AbortController().signal,
          assignment: { fence, streamId: "copied" },
        }),
        /unavailable/,
      );
    }
    await assert.rejects(
      f.dispatch("one", {
        input: { metadata: { copilotzOwnerDispatch: "reserved" } },
      }),
      /unavailable/,
    );
    assert.equal((await f.rows()).length, 2);
  } finally {
    await f.close();
  }
});

test("fresh host control policy and unforgeable exact control command are mandatory", async () => {
  const f = await fixture();
  try {
    f.state.control = false;
    await assert.rejects(f.dispatch(), /control policy denied/);
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows()).length, 0);
    assert.equal(f.bridge.snapshot().requests, 0);
    f.state.control = true;
    await f.dispatch();
    const binding = (await f.rows())[0].binding;
    await assert.rejects(
      f.owner.execute({
        principal: { kind: "worker" as const, workerId: "owner:owner" },
        ownerEpoch: 1,
        host: true,
        ownerDispatchControl: "forged",
      }, {
        kind: "assignment.retire",
        domain: "incarnation",
        key: `${ownerAssignmentKey("owner", binding)}:assignment.retire`,
        intent: binding,
      }),
      /unavailable/,
    );
    assert.equal((await f.rows())[0].retired, false);
  } finally {
    await f.close();
  }
});

test("forged source lookup is refused by durable eligibility and never Opens", async () => {
  const f = await fixture();
  try {
    const original = f.scheduled.get("one")!;
    for (
      const change of [
        { namespace: "foreign" },
        { actionId: "foreign" },
        { executionId: "foreign" },
        { sourceEventId: "foreign" },
        { deliveryId: f.scheduled.get("two")!.deliveryId },
      ]
    ) {
      f.scheduled.set("one", { ...original, ...change });
      await assert.rejects(f.dispatch(), /not eligible/);
    }
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows()).length, 0);
    assert.equal(f.bridge.snapshot().assignments, 0);
  } finally {
    await f.close();
  }
});

test("committed bind followed by rejected Open retires automatically and keeps durable recovery receipt", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.dispatch("one", { failOpen: true }), /Open failed/);
    await f.bridge.retryRetirements();
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows())[0].retired, true);
    const receipts = await f.db.query<{ kind: string; result: OwnerJson }>(
      "SELECT kind,result FROM owner_receipts WHERE kind LIKE 'assignment.%' ORDER BY kind",
    );
    assert.deepEqual(receipts.rows.map((row) => row.kind), [
      "assignment.bind",
      "assignment.retire",
    ]);
    assert.ok(!JSON.stringify(receipts.rows).includes("input-only"));
    assert.equal(
      (await f.db.query("SELECT status FROM event_deliveries WHERE id=$1", [
        f.scheduled.get("one")!.deliveryId,
      ])).rows[0].status,
      "pending",
    );
    assert.equal(f.bridge.snapshot().requests, 0);
  } finally {
    await f.close();
  }
});

test("abort during bind outer commit produces no Open and retires the known committed reservation", async () => {
  const f = await fixture();
  try {
    const entered = deferred(),
      release = deferred(),
      abort = new AbortController();
    f.state.afterTransaction = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.dispatch("one", { input: { signal: abort.signal } });
    const rejected = assert.rejects(pending, /unavailable/);
    await within(entered.promise);
    abort.abort();
    assert.equal(f.state.opened, 0);
    assert.equal(f.bridge.snapshot().assignments, 1);
    release.resolve();
    await rejected;
    await f.bridge.retryRetirements();
    assert.equal((await f.rows())[0].retired, true);
    assert.equal(f.bridge.snapshot().requests, 0);
  } finally {
    await f.close();
  }
});

test("unknown bind outcome stops owner, never Opens/rebinds, and successor can retire committed reservation", async () => {
  const f = await fixture();
  try {
    f.state.afterTransaction = () =>
      Promise.reject(new Error("lost commit acknowledgement"));
    await assert.rejects(f.dispatch(), { code: "owner_commit_unknown" });
    assert.equal(f.owner.state, "stopped");
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows())[0].retired, false);
    await f.bridge.retryRetirements();
    assert.equal(f.bridge.snapshot().failedRetirements, 1);
    await f.replaceOwner();
    await f.bridge.retryRetirements();
    assert.equal((await f.rows())[0].retired, true);
    assert.equal(f.bridge.snapshot().requests, 0);
  } finally {
    await f.close();
  }
});

test("aborted unresolved scheduled lookup remains charged; a stale late hook cannot resurrect the request", async () => {
  const f = await fixture({ maxAssignments: 1 });
  try {
    const entered = deferred(),
      release = deferred(),
      abort = new AbortController();
    f.state.lookup = async (key) => {
      entered.resolve();
      await release.promise;
      return f.scheduled.get(key);
    };
    let saved!: OwnerDispatchInput;
    const pending = f.dispatch("one", {
      input: { signal: abort.signal },
      beforeHook(input) {
        saved = input;
      },
    });
    const rejected = assert.rejects(pending, /unavailable/);
    await within(entered.promise);
    abort.abort();
    assert.equal(f.bridge.snapshot().requests, 1);
    await assert.rejects(f.dispatch("two"), /unavailable/);
    release.resolve();
    await rejected;
    assert.equal(f.bridge.snapshot().requests, 0);
    await assert.rejects(
      f.bridge.lifecycle.onWorkAssigned({
        operationId: "late",
        workload: "action",
        metadata: saved.metadata!,
        signal: new AbortController().signal,
        assignment: { fence, streamId: "late" },
      }),
      /unavailable/,
    );
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows()).length, 0);
  } finally {
    await f.close();
  }
});

test("fresh exact session, parent, epoch, and all durable binding fields are checked inside SQL", async () => {
  const f = await fixture();
  try {
    const opened = await f.dispatch();
    const call = await witness(f, opened.context());
    const row = (await f.rows())[0];
    for (
      const change of [
        { sessionId: "foreign" },
        { workerAttemptId: "foreign" },
        { sessionGeneration: 99 },
        { parentOperationId: "foreign" },
        { assignmentId: "foreign" },
        { dispatchAttemptId: "foreign" },
        { namespace: "foreign" },
        { sourceEventId: "foreign" },
        { deliveryId: "foreign" },
        { ownerEpoch: 99 },
      ]
    ) {
      await assert.rejects(
        f.resolve({ ...call.caller, ...change }),
        /business policy denied|Caller owner principal is stale or mismatched/,
      );
    }
    for (
      const change of [
        { dispatchAttemptId: "foreign" },
        { namespace: "foreign" },
        { executionId: "foreign" },
        { sourceEventId: "foreign" },
        { deliveryId: "foreign" },
      ]
    ) {
      await f.db.query("UPDATE owner_assignments SET binding=$1::jsonb", [
        JSON.stringify({ ...row.binding, ...change }),
      ]);
      await assert.rejects(f.resolve(call.caller), /business policy denied/);
    }
    await f.db.query("UPDATE owner_assignments SET binding=$1::jsonb", [
      JSON.stringify(row.binding),
    ]);
    f.state.fence = { ...f.state.fence, sessionGeneration: 2 };
    await assert.rejects(f.resolve(call.caller), /business policy denied/);
    assert.equal(
      await f.bridge.wrapWorkerCalls({
        admit() {
          throw new Error("must not admit");
        },
      }).admit(opened.context(undefined, { fence })),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("session replacement or revocation during durable Started read suppresses authorization", async () => {
  const f = await fixture();
  try {
    const opened = await f.dispatch();
    const call = await witness(f, opened.context());
    const intercepted: SqlExecutor = {
      async query<T extends Record<string, unknown>>(
        sql: string,
        args?: unknown[],
      ) {
        const result = await f.db.query<T>(sql, args);
        f.state.fence = { ...f.state.fence, connectionId: "replacement" };
        return result;
      },
    };
    assert.equal(
      await f.bridge.resolveStarted(intercepted, call.caller),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("completion and disconnect revoke synchronously; retirement failure remains bounded and visible", async () => {
  const f = await fixture({ maxAssignments: 1 });
  try {
    const opened = await f.dispatch();
    const call = await witness(f, opened.context());
    f.state.control = false;
    f.bridge.lifecycle.onComplete({
      operationId: opened.handle.operationId,
      streamId: opened.handle.streamId,
      fence,
    });
    assert.equal(
      f.bridge.resolveAssignment(opened.context(), "owner"),
      undefined,
    );
    await assert.rejects(f.resolve(call.caller), /business policy denied/);
    await f.bridge.retryRetirements();
    assert.equal(f.bridge.snapshot().failedRetirements, 1);
    await assert.rejects(f.dispatch("two"), /unavailable/);
    assert.equal((await f.rows())[0].retired, false);
    f.state.control = true;
    opened.completion.resolve("complete");
    await f.bridge.retryRetirements();
    assert.equal((await f.rows())[0].retired, true);
    assert.equal(f.bridge.snapshot().witnesses, 0);
    const next = await f.dispatch("two");
    const nextCall = await witness(f, next.context());
    f.bridge.lifecycle.onDisconnect({ fence });
    await assert.rejects(f.resolve(nextCall.caller), /business policy denied/);
  } finally {
    await f.close();
  }
});

test("witness cap retains cancelled noncooperative admission and handler until actual settlement", async () => {
  const f = await fixture({ maxWitnesses: 1 });
  try {
    const opened = await f.dispatch();
    const entered = deferred(),
      release = deferred(),
      abort = new AbortController();
    const admission = f.bridge.wrapWorkerCalls({
      async admit() {
        entered.resolve();
        await release.promise;
        return () => Promise.resolve(new Uint8Array());
      },
    });
    const pending = admission.admit(opened.context(abort.signal));
    await entered.promise;
    abort.abort();
    assert.equal(f.bridge.snapshot().witnesses, 1);
    assert.equal(await admission.admit(opened.context()), undefined);
    release.resolve();
    assert.equal(await pending, undefined);
    assert.equal(f.bridge.snapshot().witnesses, 0);
    const handlerEntered = deferred(),
      handlerRelease = deferred(),
      handlerAbort = new AbortController();
    let caller!: OwnerCaller;
    const running = f.bridge.wrapWorkerCalls({
      admit(ctx) {
        caller = f.bridge.resolveAssignment(ctx, "owner")!.caller;
        return async () => {
          handlerEntered.resolve();
          await handlerRelease.promise;
          return new Uint8Array();
        };
      },
    });
    const handler = (await running.admit(opened.context()))!;
    const result = handler({ input: stream(), signal: handlerAbort.signal });
    const rejected = assert.rejects(result, /unavailable/);
    await handlerEntered.promise;
    handlerAbort.abort();
    await assert.rejects(f.resolve(caller), /business policy denied/);
    assert.equal(f.bridge.snapshot().witnesses, 1);
    assert.equal(await running.admit(opened.context()), undefined);
    handlerRelease.resolve();
    await rejected;
    assert.equal(f.bridge.snapshot().witnesses, 0);
  } finally {
    await f.close();
  }
});

test("callback object, binding, and signal mutation cannot alter private evidence or revive cancellation", async () => {
  const f = await fixture();
  try {
    const opened = await f.dispatch();
    const abort = new AbortController();
    let captured!: OwnerWorkerCallContext;
    let caller!: OwnerCaller;
    const admission = f.bridge.wrapWorkerCalls({
      admit(ctx) {
        captured = ctx;
        const found = f.bridge.resolveAssignment(ctx, "owner")!;
        caller = found.caller;
        (found.binding as { deliveryId: string }).deliveryId = "mutated";
        (ctx.fence.identity as { workerId: string }).workerId = "mutated";
        (ctx.parent as { operationId: string }).operationId = "mutated";
        Object.defineProperty(ctx.signal, "aborted", { value: false });
        Object.defineProperty(ctx.signal, "throwIfAborted", { value() {} });
        assert.equal("copilotzOwnerDispatch" in ctx.parent!.metadata, false);
        return () => Promise.resolve(new Uint8Array());
      },
    });
    const handler = await admission.admit(opened.context(abort.signal));
    assert.ok(handler);
    assert.equal(
      (await f.resolve(caller) as OwnerAssignmentBinding).deliveryId,
      f.scheduled.get("one")!.deliveryId,
    );
    assert.equal(
      f.bridge.resolveAssignment({ ...captured }, "owner"),
      undefined,
    );
    abort.abort();
    assert.equal(f.bridge.resolveAssignment(captured, "owner"), undefined);
    await assert.rejects(f.resolve(caller), /business policy denied/);
    await assert.rejects(
      handler({ input: stream(), signal: new AbortController().signal }),
      /unavailable/,
    );
    assert.equal(f.bridge.snapshot().witnesses, 0);
  } finally {
    await f.close();
  }
});

test("actual connection admission composes with private witness while current business grants remain mandatory", async () => {
  const f = await fixture();
  try {
    const opened = await f.dispatch();
    const connection = createOwnerWorkerCallAdmission({
      resolveOwner: () => f.owner,
      resolveAssignment(context, ownerId) {
        const found = f.bridge.resolveAssignment(context, ownerId);
        return found
          ? { ...found, ctxGranted: true, settlementGranted: false }
          : undefined;
      },
    });
    const wrapped = f.bridge.wrapWorkerCalls(connection);
    const handler = await wrapped.admit(opened.context());
    assert.ok(handler);
    f.state.policy = false;
    const result = await handler({
      input: stream({ kind: "binding", input: null }),
      signal: new AbortController().signal,
    });
    assert.equal(JSON.parse(new TextDecoder().decode(result)).ok, false);
    assert.equal(f.bridge.snapshot().witnesses, 0);
    f.state.policy = true;
    const allowed = await wrapped.admit(opened.context());
    assert.ok(allowed);
    const reply = JSON.parse(
      new TextDecoder().decode(
        await allowed({
          input: stream({ kind: "binding", input: null }),
          signal: new AbortController().signal,
        }),
      ),
    );
    assert.equal(reply.ok, true);
    assert.equal(reply.value.deliveryId, f.scheduled.get("one")!.deliveryId);
  } finally {
    await f.close();
  }
});

test("dispatch handle cancellation and completed rejection retire without relying on lifecycle callbacks", async () => {
  const f = await fixture();
  try {
    const first = await f.dispatch();
    const firstCall = await witness(f, first.context());
    await first.handle.cancel();
    await assert.rejects(f.resolve(firstCall.caller), /business policy denied/);
    await f.bridge.retryRetirements();
    const second = await f.dispatch("two");
    const secondCall = await witness(f, second.context());
    second.completion.reject(new Error("transport closed"));
    await Promise.resolve();
    await assert.rejects(
      f.resolve(secondCall.caller),
      /business policy denied/,
    );
    await f.bridge.retryRetirements();
    assert.ok((await f.rows()).every((row) => row.retired));
    assert.equal(f.bridge.snapshot().requests, 0);
  } finally {
    await f.close();
  }
});

test("retirement snapshots one bounded batch; arrivals get a separate wake without unbounded promise growth", async () => {
  const f = await fixture({ maxAssignments: 2 });
  const firstRelease = deferred(), secondRelease = deferred();
  try {
    const first = await f.dispatch("one"), second = await f.dispatch("two");
    const firstEntered = deferred(), secondEntered = deferred();
    let calls = 0;
    f.state.beforePolicy = async () => {
      calls++;
      if (calls === 1) {
        firstEntered.resolve();
        await firstRelease.promise;
      } else if (calls === 2) {
        secondEntered.resolve();
        await secondRelease.promise;
      }
    };
    f.bridge.retireOperation(first.handle.operationId);
    const firstBatch = f.bridge.retryRetirements();
    await within(firstEntered.promise);
    f.bridge.retireOperation(second.handle.operationId);
    assert.equal(f.bridge.snapshot().controls, 1);
    firstRelease.resolve();
    await within(firstBatch);
    await within(secondEntered.promise);
    assert.equal(calls, 2);
    assert.equal(f.bridge.snapshot().controls, 1);
    assert.equal(f.bridge.snapshot().retirements, 1);
    secondRelease.resolve();
    await f.bridge.retryRetirements();
    assert.equal(f.bridge.snapshot().retirements, 0);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await f.close();
  }
});

test("refused admission, handler failure, malformed output, and stale admitted handler release witness capacity", async () => {
  const f = await fixture({ maxWitnesses: 1 });
  try {
    const opened = await f.dispatch();
    assert.equal(
      await f.bridge.wrapWorkerCalls({
        admit() {
          return undefined;
        },
      }).admit(opened.context()),
      undefined,
    );
    await assert.rejects(
      f.bridge.wrapWorkerCalls({
        admit() {
          throw new Error("admission failure");
        },
      }).admit(opened.context()),
      /admission failure/,
    );
    for (
      const bad of [
        () => Promise.reject(new Error("handler failure")),
        () => Promise.resolve("malformed" as unknown as Uint8Array),
      ]
    ) {
      const handler = (await f.bridge.wrapWorkerCalls({
        admit: () => bad,
      }).admit(opened.context()))!;
      await assert.rejects(
        handler({ input: stream(), signal: new AbortController().signal }),
        /handler failure|must return bytes/,
      );
      assert.equal(f.bridge.snapshot().witnesses, 0);
    }
    const call = await witness(f, opened.context());
    f.state.fence = { ...f.state.fence, sessionGeneration: 2 };
    await assert.rejects(
      call.handler({ input: stream(), signal: new AbortController().signal }),
      /unavailable/,
    );
    assert.equal(f.bridge.snapshot().witnesses, 0);
  } finally {
    await f.close();
  }
});

test("owner/session replacement after committed bind suppresses Open and keeps retirement recoverable", async () => {
  const f = await fixture();
  try {
    const entered = deferred(), release = deferred();
    f.state.afterTransaction = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.dispatch();
    const rejected = assert.rejects(pending, /unavailable/);
    await within(entered.promise);
    await f.replaceOwner();
    f.state.fence = { ...f.state.fence, sessionGeneration: 2 };
    release.resolve();
    await rejected;
    assert.equal(f.state.opened, 0);
    await f.bridge.retryRetirements();
    assert.equal((await f.rows())[0].retired, true);
  } finally {
    await f.close();
  }
});

test("metadata depth/node/byte and identifier bounds reject before reserving capacity", async () => {
  const f = await fixture({ maxAssignments: 1 });
  try {
    let deep: OwnerJson = null;
    for (let i = 0; i < 34; i++) deep = { child: deep };
    const largeNodes = Array.from({ length: 4100 }, () => 1);
    for (
      const metadata of [
        { value: "x".repeat(32769) },
        { value: "é".repeat(20000) },
        { deep },
        { largeNodes },
      ] as Array<Record<string, OwnerJson>>
    ) {
      await assert.rejects(f.dispatch("one", { input: { metadata } }));
      assert.equal(f.bridge.snapshot().requests, 0);
    }
    for (const workload of ["", "x".repeat(129), "invalid workload"]) {
      await assert.rejects(
        f.dispatch("one", { input: { workload } }),
        /unavailable/,
      );
    }
    await assert.rejects(f.dispatch("x".repeat(1025)), /unavailable/);
    assert.equal(f.state.opened, 0);
    assert.equal(f.bridge.snapshot().requests, 0);
    await f.dispatch();
    assert.equal(f.state.opened, 1);
  } finally {
    await f.close();
  }
});

test("Processor bridge preserves exact Started witness and rejects Action reinterpretation", async () => {
  const f = await fixture({ processor: true });
  try {
    const opened = await f.dispatch();
    const [row] = await f.rows();
    assert.equal("kind" in row.binding && row.binding.kind, "processor");
    assert.equal("actionId" in row.binding, false);
    assert.equal("executionId" in row.binding, false);
    assert.equal(
      f.bridge.resolveAssignment(opened.context(), "owner"),
      undefined,
    );
    const call = await witness(f, opened.context());
    assert.deepEqual(await f.resolve(call.caller), row.binding);
    for (
      const changed of [
        { processorId: "foreign" },
        { kind: "action" },
        { actionId: "work", executionId: "one" },
        { sourceEventId: "foreign" },
      ]
    ) await assert.rejects(f.resolve({ ...call.caller, ...changed }));
    await call.handler({
      input: stream(),
      signal: new AbortController().signal,
    });
    await assert.rejects(f.resolve(call.caller));
  } finally {
    await f.close();
  }
});

test("control witness rechecks the exact owner holder after asynchronous policy", async () => {
  const f = await fixture();
  try {
    f.state.beforePolicy = async () => {
      await Promise.resolve();
      f.replaceHolderIdentity("different-holder");
    };
    await assert.rejects(f.dispatch(), /unavailable/);
    assert.equal(f.state.opened, 0);
    assert.equal((await f.rows()).length, 0);
  } finally {
    await f.close();
  }
});
