import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createOwnerAlarmDriver } from "./alarms.ts";
import type { SqlSession } from "../events/session.ts";

function fixture(
  query: (sql: string) => Promise<unknown[]>,
  cancelError?: Error,
) {
  const session: SqlSession = {
    async query<T extends Record<string, unknown>>(sql: string) {
      return { rows: await query(sql) as T[] };
    },
    transaction() {
      throw new Error("Unexpected transaction");
    },
  };
  const timers = new Map<number, () => void>();
  let next = 0;
  const driver = createOwnerAlarmDriver({
    session,
    schema: "lifecycle",
    owner: "schema",
    now: () => new Date(0),
    ready: () => true,
    stopped: () => false,
    fail() {},
    scheduler: {
      schedule(callback) {
        const id = ++next;
        timers.set(id, callback);
        return id;
      },
      cancel(handle) {
        timers.delete(handle as number);
        if (cancelError) throw cancelError;
      },
    },
  });
  return { driver, timers };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
}

Deno.test("owner alarm shutdown drains an admitted wake-time read without rearming", async () => {
  const entered = Promise.withResolvers<void>();
  const read = Promise.withResolvers<unknown[]>();
  const { driver, timers } = fixture(() => {
    entered.resolve();
    return read.promise;
  });
  const rearm = driver.rearm();
  await entered.promise;
  driver.pause();
  const drained = driver.drain();
  assertEquals(await isPending(drained), true);
  read.resolve([{ due_at: new Date(1000) }]);
  await rearm;
  await drained;
  assertEquals(timers.size, 0);
});

Deno.test("owner alarm shutdown drains a rejected admitted read without detached rejection", async () => {
  const read = Promise.withResolvers<unknown[]>();
  const { driver, timers } = fixture(() => read.promise);
  const rejected = assertRejects(() => driver.rearm(), Error, "read failed");
  driver.pause();
  const drained = driver.drain();
  assertEquals(await isPending(drained), true);
  read.reject(new Error("read failed"));
  await rejected;
  await drained;
  assertEquals(timers.size, 0);
});

Deno.test("owner alarm cancellation errors do not skip draining late source callbacks", async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const error = new Error("cancel failed");
  const { driver, timers } = fixture(
    (sql) =>
      Promise.resolve(
        sql.includes("owner_deadlines")
          ? [{
            source: "test",
            key: "work",
            namespace: null,
            due_at: new Date(0),
            payload: null,
            revision: "1",
          }]
          : [{ due_at: new Date(1000) }],
      ),
    error,
  );
  driver.register({
    name: "test",
    async wake() {
      entered.resolve();
      await released.promise;
    },
  });
  await driver.rearm();
  const wake = driver.wake();
  await entered.promise;
  assertThrows(() => driver.pause(), Error, "cancel failed");
  const drained = driver.drain();
  assertEquals(await isPending(drained), true);
  released.resolve();
  await wake;
  await drained;
  assertEquals(timers.size, 0);
});

Deno.test("owner alarm cancellation failure still disables stale callbacks", async () => {
  let runs = 0;
  const released = Promise.withResolvers<void>();
  const { driver, timers } = fixture(
    (sql) =>
      Promise.resolve(
        sql.includes("owner_deadlines")
          ? [{
            source: "test",
            key: "work",
            namespace: null,
            due_at: new Date(0),
            payload: null,
            revision: "1",
          }]
          : [{ due_at: new Date(1000) }],
      ),
    new Error("cancel failed"),
  );
  driver.register({
    name: "test",
    async wake() {
      runs++;
      await released.promise;
    },
  });
  await driver.rearm();
  const callback = [...timers.values()][0];
  assertThrows(() => driver.pause(), Error, "cancel failed");
  callback();
  await driver.wake();
  await driver.drain();
  assertEquals(runs, 0);
  // A throwing scheduler cannot revive a paused owner or start another read.
  assertEquals(timers.size, 0);
});

Deno.test("shared owner drain is bounded while surviving attachments commit new deadlines", async () => {
  const first = Promise.withResolvers<unknown[]>();
  const survivor = Promise.withResolvers<unknown[]>();
  let reads = 0;
  const { driver, timers } = fixture(() =>
    ++reads === 1 ? first.promise : survivor.promise
  );
  const admitted = driver.rearm();
  const drained = driver.drain();
  const later = driver.rearm();
  try {
    assertEquals(await isPending(drained), true);
    first.resolve([]);
    await admitted;
    // Allow the captured Promise.allSettled continuation to complete, without
    // settling the surviving attachment's independently admitted query.
    for (let index = 0; index < 8; index++) await Promise.resolve();
    assertEquals(await isPending(drained), false);
    assertEquals(await isPending(later), true);
  } finally {
    survivor.resolve([]);
    await later;
    await drained;
    driver.committed(new Date(1000).toISOString());
  }
  assertEquals(timers.size, 1);
  driver.pause();
  await driver.drain();
});

Deno.test("disposing one alarm source restores the surviving attachment before new wakes", async () => {
  const calls: string[] = [];
  const { driver } = fixture((sql) =>
    Promise.resolve(
      sql.includes("owner_deadlines")
        ? [{
          source: "shared",
          key: "work",
          namespace: null,
          due_at: new Date(0),
          payload: null,
          revision: "1",
        }]
        : [],
    )
  );
  driver.register({
    name: "shared",
    wake() {
      calls.push("survivor");
      return Promise.resolve();
    },
  });
  const dispose = driver.register({
    name: "shared",
    wake() {
      calls.push("closing");
      return Promise.resolve();
    },
  });
  dispose();
  await driver.wake();
  await driver.drain();
  assertEquals(calls, ["survivor"]);
  driver.pause();
});
