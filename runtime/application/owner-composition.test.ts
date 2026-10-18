import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCopilotz as rootFactory } from "../../create-copilotz.ts";
import { createCopilotz as workerFactory, defineAction } from "../../worker.ts";
import type { OwnerConnectionOptions } from "./owner-composition-types.ts";
import type { OwnerHostCaller } from "../owner/connection.ts";

type CreateWorker = OwnerConnectionOptions["worker"]["createWorker"];
type WorkerLifecycleCallbacks = Parameters<CreateWorker>[1];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let lifecycle: WorkerLifecycleCallbacks;
  let session = "initial";
  let stopped = 0;
  let resultPending = false;
  let readyGate: ReturnType<typeof deferred> | undefined;
  const closed = deferred();
  const calls: { workload: string; body: Record<string, unknown> }[] = [];
  const signals: AbortController[] = [];
  const action = defineAction({
    id: "fixture.echo",
    execute: (input: string) => input,
  });
  const factory = ((_connection, callbacks) => {
    lifecycle = callbacks;
    return {
      ready: Promise.resolve(),
      closed: closed.promise,
      snapshot: () => ({ connectionId: session }),
      stop() {
        stopped++;
        for (const signal of signals) signal.abort(new Error("stopped"));
        closed.resolve();
        return Promise.resolve();
      },
      async callHost(input: Parameters<OwnerHostCaller>[0]) {
        await Promise.resolve();
        const body = JSON.parse(
          new TextDecoder().decode(input.body as Uint8Array),
        );
        calls.push({ workload: input.workload, body });
        if (input.workload === "copilotz.owner.ready") await readyGate?.promise;
        let value: unknown;
        if (input.workload === "copilotz.owner.ready") {
          value = {
            protocol: "copilotz.owner.v1",
            ownerId: "owner",
            features: ["commands", "projections", "settlement"],
          };
        } else if (input.workload === "copilotz.owner.action-call") {
          value = {
            status: "committed",
            result: {
              namespace: "space",
              actionId: "fixture.echo",
              executionId: "execution",
              eventId: "event",
              deliveryId: "delivery",
            },
          };
        } else {value = resultPending
            ? { status: "pending" }
            : { status: "completed", output: "done" };}
        return {
          output: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ ok: true, value })),
              );
              controller.close();
            },
          }),
          completed: Promise.resolve(),
          cancel: () => Promise.resolve(),
        };
      },
    } as never;
  }) as CreateWorker;
  const options = {
    namespace: "space",
    owner: { id: "owner" },
    actions: {
      echo: action,
      serverInvoke: defineAction({
        id: "fixture.server-invoke",
        execute: (input: string) => input,
      }),
    },
    worker: {
      connection: {
        id: "worker",
        transport: { type: "in-process", config: { topic: "unused" } },
      } as never,
      createWorker: factory,
    },
  };
  return {
    options,
    calls,
    stopped: () => stopped,
    pending() {
      resultPending = true;
    },
    holdReadiness() {
      readyGate = deferred();
    },
    releaseReadiness() {
      readyGate?.resolve(undefined);
    },
    start(id = "initial") {
      session = id;
      const signal = new AbortController();
      signals.push(signal);
      void lifecycle?.onReady?.(
        { snapshot: { connectionId: id }, signal: signal.signal } as never,
      );
      return signal;
    },
  };
}

test("public owner factories preserve inferred Actions, idempotencyKey and namespace; reserved ingress stays hidden", async () => {
  for (const factory of [rootFactory, workerFactory]) {
    const f = fixture();
    const app = await factory(f.options);
    assert.equal("serverInvoke" in app.actions, false);
    await assert.rejects(
      app.actions.echo("early"),
      /owner_session_unavailable/,
    );
    f.start();
    await app.ready;
    const value: string = await app.actions.echo("input", {
      idempotencyKey: "key",
      namespace: "space",
    });
    assert.equal(value, "done");
    const admitted = f.calls.find((call) =>
      call.workload === "copilotz.owner.action-call"
    )!;
    assert.equal(admitted.body.operationKey, "key");
    assert.equal(admitted.body.actionAlias, "echo");
    assert.equal("namespace" in admitted.body, false);
    const before = f.calls.length;
    for (
      const options of [
        { namespace: "other" },
        { idempotencyKey: " " },
        { operationKey: "wrong" },
        { actionMetadata: {} },
        { databaseSchema: "other" },
      ]
    ) {
      await assert.rejects(app.actions.echo("bad", options as never));
    }
    assert.equal(f.calls.length, before);
    await app.close();
    await app.closed;
    assert.equal(f.stopped(), 1);
  }
});

test("session replacement revokes pending public waits and requires a new owner-ready handshake", async () => {
  const f = fixture();
  const app = await workerFactory(f.options);
  f.start();
  await app.ready;
  f.pending();
  const result = app.actions.echo("pending", { idempotencyKey: "pending" });
  while (f.calls.length < 3) await delay(1);
  f.holdReadiness();
  // A replacement readiness callback itself revokes the prior public wait,
  // even before a transport delivers the old session abort notification.
  f.start("replacement");
  await assert.rejects(result, /action_wait_interrupted/);
  await assert.rejects(
    app.actions.echo("blocked"),
    /owner_session_unavailable/,
  );
  f.releaseReadiness();
  await delay(10);
  await app.close();
  await app.closed;
});

test("unsupported storage, legacy mixing and definitions refuse before starting a worker", async () => {
  const f = fixture();
  for (
    const options of [
      { ...f.options, storage: {} },
      { ...f.options, role: "worker" },
      { ...f.options, database: {} },
      { ...f.options, namespace: " " },
      { ...f.options, actionWait: { maxPending: 0 } },
      {
        ...f.options,
        worker: { ...f.options.worker, connection: { workloads: {} } },
      },
      {
        ...f.options,
        actions: {
          protected: defineAction({
            id: "fixture.secret",
            inputSchema: { type: "string", "x-copilotz-secret": true },
            execute: (v: string) => v,
          }),
        },
      },
    ]
  ) await assert.rejects(workerFactory(options as never));
  assert.equal(f.calls.length, 0);
  assert.equal(f.stopped(), 0);
});

// Public overloads retain inference and reject unsupported placement/surface at compile time.
async function compilePublicContract(
  options: ReturnType<typeof fixture>["options"],
) {
  const app = await workerFactory(options);
  const result: string = await app.actions.echo("input", {
    idempotencyKey: "key",
  });
  void result;
  // @ts-expect-error Public calls do not accept the internal ctx operationKey.
  app.actions.echo("input", { operationKey: "key" });
  // @ts-expect-error Reserved HTTP ingress is never a public Action caller.
  app.actions.serverInvoke("input");
  // @ts-expect-error This bounded result does not claim a full Collection read facade.
  app.collections.notes.get({ id: "id" });
  // @ts-expect-error Worker-role factory never accepts storage.
  workerFactory({ ...options, storage: {} });
  // @ts-expect-error New owner composition cannot mix with a legacy role.
  rootFactory({ ...options, role: "worker" });
}
void compilePublicContract;

test("known invalid public wait bounds refuse storage before SQL or transport startup", async () => {
  const f = fixture();
  const { owner: _owner, ...common } = f.options;
  let sql = 0;
  let transports = 0;
  const options = {
    ...common,
    storage: {
      ownerId: "owner",
      holderId: "holder",
      schema: "public",
      initialization: "fresh",
      session: {
        query() {
          sql++;
          throw new Error("must not query");
        },
        transaction() {
          sql++;
          throw new Error("must not transact");
        },
      },
      policy: {
        ingress() {},
        worker() {},
        input() {},
        collections() {
          return {};
        },
        effectOutcome: () => false,
        effectNotStarted: () => false,
      },
      transport: { transports: [] },
      createTransport() {
        transports++;
        throw new Error("must not create transport");
      },
    },
  };
  for (
    const bounds of [
      { childWaitMs: 0 },
      { childWaitMs: 60_001 },
      { ownerReadyTimeoutMs: 0 },
      { ownerReadyTimeoutMs: 120_001 },
      { ownerReadyTimeoutMs: NaN },
    ]
  ) {
    await assert.rejects(
      rootFactory({ ...options, ...bounds } as never),
      /Invalid owner composition/,
    );
  }
  assert.equal(sql, 0);
  assert.equal(transports, 0);
  assert.equal(f.calls.length, 0);
});
