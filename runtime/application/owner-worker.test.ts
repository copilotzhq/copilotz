import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOwnerConnectedWorker } from "./owner-worker.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type {
  createWorker,
  WorkerLifecycleCallbacks,
} from "../../dependencies/oxian-worker.ts";
import type { OwnerHostCaller } from "../owner/connection.ts";
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(childWaitMs?: number) {
  let lifecycle!: NonNullable<WorkerLifecycleCallbacks>;
  let connectionId = "first";
  let stopped = 0;
  const closed = deferred<never>();
  const requests: {
    input: Parameters<OwnerHostCaller>[0];
    response: ReturnType<typeof deferred<Awaited<ReturnType<OwnerHostCaller>>>>;
  }[] = [];
  const factory = ((
    _options: Parameters<typeof createWorker>[0],
    callbacks: WorkerLifecycleCallbacks,
  ) => {
    lifecycle = callbacks!;
    return {
      ready: Promise.resolve(),
      closed: closed.promise,
      stop() {
        stopped++;
        return Promise.resolve();
      },
      snapshot: () => ({ connectionId }),
      callHost(input: Parameters<OwnerHostCaller>[0]) {
        const response = deferred<Awaited<ReturnType<OwnerHostCaller>>>();
        requests.push({ input, response });
        return response.promise;
      },
    };
  }) as unknown as typeof createWorker;
  const worker = createOwnerConnectedWorker({
    registry: createPluginRegistry({}),
    ownerId: "owner",
    namespace: "space",
    childWaitMs,
    worker: {
      id: "worker",
      transport: { type: "in-process", config: { topic: "unused" } },
    } as never,
    createCapabilities: () => ({ resources: {}, adapters: {} }),
  }, factory);
  const start = (id: string) => {
    connectionId = id;
    const signal = new AbortController();
    void lifecycle.onReady!(
      { snapshot: { connectionId: id }, signal: signal.signal } as never,
    );
    return signal;
  };
  const release = (index: number, valid = true) => {
    const body = valid
      ? {
        ok: true,
        value: {
          protocol: "copilotz.owner.v1",
          ownerId: "owner",
          features: ["commands", "projections", "settlement"],
        },
      }
      : { ok: false, outcome: "refused", code: "owner_admission_refused" };
    requests[index].response.resolve({
      output: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          c.close();
        },
      }),
      completed: Promise.resolve(),
      cancel: () => Promise.resolve(),
    });
  };
  return { worker, start, requests, release, stopped: () => stopped };
}
test("old session probe failure cannot retire a replacement before first application readiness", async () => {
  const f = fixture();
  const old = f.start("first");
  await delay(0);
  assert.equal(f.requests.length, 1);
  old.abort(new Error("session replaced"));
  f.start("second");
  await delay(0);
  assert.equal(f.requests.length, 2);
  f.release(1);
  await f.worker.ready;
  assert.equal(f.worker.snapshot().ownerReady, true);
  assert.equal(f.stopped(), 0);
  f.release(0);
  await delay(0);
  assert.equal(f.stopped(), 0);
});
test("current session handshake refusal retires transport even after initial readiness", async () => {
  const f = fixture();
  const old = f.start("first");
  await delay(0);
  f.release(0);
  await f.worker.ready;
  old.abort();
  f.start("second");
  await delay(0);
  f.release(1, false);
  await delay(0);
  assert.equal(f.worker.snapshot().ownerReady, false);
  assert.equal(f.stopped(), 1);
});

test("private child wait timeout is bounded before worker transport creation", async () => {
  for (const childWaitMs of [0, -1, 1.5, 60_001, NaN, Infinity]) {
    let opened = false;
    const factory = (() => {
      opened = true;
      throw new Error("Unexpected transport construction.");
    }) as unknown as typeof createWorker;
    assert.throws(() =>
      createOwnerConnectedWorker({
        registry: createPluginRegistry({}),
        ownerId: "owner",
        namespace: "space",
        worker: {} as never,
        childWaitMs,
        createCapabilities: () => ({ resources: {}, adapters: {} }),
      }, factory), /Child Action wait timeout is invalid/);
    assert.equal(opened, false);
  }
  for (const childWaitMs of [1, 60_000]) {
    const f = fixture(childWaitMs);
    await f.worker.close();
    assert.equal(f.stopped(), 1);
  }
});
