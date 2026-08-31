import { assert, assertEquals, assertRejects } from "@std/assert";

import type { CopilotzDatabase } from "./lifecycle.ts";
import {
  createCopilotzPersistence,
  isCopilotzPersistenceError,
  isPersistenceUnavailable,
  openCopilotzPersistence,
} from "./lifecycle.ts";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

type TransactionOperation = (
  transaction: Readonly<{ query: CopilotzDatabase["query"] }>,
) => unknown | Promise<unknown>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return Object.freeze({ promise, resolve, reject });
}

function connectionError(): Error & { code: string } {
  return Object.assign(new Error("connection reset by peer"), {
    code: "ECONNRESET",
  });
}

function hypervisorSessionError(
  code:
    | "connection_lost"
    | "indeterminate"
    | "worker_unavailable"
    | "shutting_down",
): Error & { name: "HypervisorError"; code: typeof code } {
  return Object.assign(new Error(`Oxian session ${code}`), {
    name: "HypervisorError" as const,
    code,
  });
}

function databaseGeneration(
  id: number,
  options: Readonly<{
    query?: (sql: string) => Promise<readonly Record<string, unknown>[]>;
    transaction?: (
      operation: TransactionOperation,
      query: CopilotzDatabase["query"],
    ) => Promise<unknown>;
    listen?: NonNullable<CopilotzDatabase["listen"]>;
    close?: () => void | Promise<void>;
  }> = {},
): CopilotzDatabase {
  const query: CopilotzDatabase["query"] = async <
    TRow extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string) => {
    const rows = options.query
      ? await options.query(sql)
      : [{ generation: id }];
    return { rows: [...rows] as TRow[] };
  };
  return Object.freeze({
    query,
    async transaction<T>(
      operation: (
        transaction: Readonly<{ query: CopilotzDatabase["query"] }>,
      ) => T | Promise<T>,
    ) {
      if (options.transaction) {
        return await options.transaction(operation, query) as T;
      }
      return await operation(Object.freeze({ query }));
    },
    ...(options.listen ? { listen: options.listen } : {}),
    async close() {
      await options.close?.();
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached before the test deadline.");
}

Deno.test("persistence reconnects once, never replays the failed operation, and preserves lifecycle order", async () => {
  const replacement = deferred<CopilotzDatabase>();
  const lifecycle: string[] = [];
  const participant: string[] = [];
  const closes: number[] = [];
  let connections = 0;
  let failedCalls = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        connections += 1;
        if (generation === 1) {
          return databaseGeneration(1, {
            async query(sql) {
              if (sql === "fail") {
                failedCalls += 1;
                throw connectionError();
              }
              return [{ generation: 1 }];
            },
            close: () => {
              closes.push(1);
            },
          });
        }
        return replacement.promise;
      },
    },
    databaseRecovery: { waitMs: 100 },
  }, {
    onUnavailable: ({ generation }) => {
      lifecycle.push(`unavailable:${generation}`);
    },
    onReconnecting: ({ generation }) => {
      lifecycle.push(`reconnecting:${generation}`);
    },
    onReady: ({ generation }) => {
      lifecycle.push(`ready:${generation}`);
    },
  });
  persistence.recovery!.register({
    onUnavailable: (error) => {
      participant.push(error.code);
    },
    onReady: ({ generation }) => {
      participant.push(`ready:${generation}`);
    },
  });

  try {
    const error = await assertRejects(() => persistence.database.query("fail"));
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    assertEquals(error.indeterminate, true);
    assertEquals(failedCalls, 1);
    await waitFor(() => connections === 2);

    const first = persistence.database.query<{ generation: number }>("first");
    const second = persistence.database.query<{ generation: number }>(
      "second",
    );
    replacement.resolve(databaseGeneration(2, {
      close: () => {
        closes.push(2);
      },
    }));
    assertEquals((await first).rows[0].generation, 2);
    assertEquals((await second).rows[0].generation, 2);
    assertEquals(connections, 2);
    assertEquals(failedCalls, 1);
    assertEquals(lifecycle, [
      "ready:1",
      "unavailable:1",
      "reconnecting:1",
      "ready:2",
    ]);
    assertEquals(participant, [
      "persistence_indeterminate",
      "ready:2",
    ]);
    await waitFor(() => closes.includes(1));
  } finally {
    await persistence.close();
  }
  assertEquals(closes, [1, 2]);
});

Deno.test("recoverable persistence keeps PostgreSQL listeners bound across generations", async () => {
  const handlers = new Map<
    number,
    (notification: { channel: string; payload?: string }) => void
  >();
  const listenerCloses: number[] = [];
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        return databaseGeneration(generation, {
          query(sql) {
            return sql === "fail"
              ? Promise.reject(connectionError())
              : Promise.resolve([{ generation }]);
          },
          async listen(_channel, handler) {
            handlers.set(generation, handler);
            return {
              async close() {
                handlers.delete(generation);
                listenerCloses.push(generation);
              },
            };
          },
        });
      },
    },
    databaseRecovery: { waitMs: 100 },
  });
  const received: string[] = [];
  const subscription = await persistence.database.listen!(
    "copilotz_operations",
    (notification) => received.push(notification.payload ?? ""),
  );
  try {
    handlers.get(1)?.({ channel: "copilotz_operations", payload: "one" });
    await assertRejects(() => persistence.database.query("fail"));
    await persistence.recovery!.admit();
    handlers.get(2)?.({ channel: "copilotz_operations", payload: "two" });
    assertEquals(received, ["one", "two"]);
  } finally {
    await subscription.close();
    await persistence.close();
  }
  assert(listenerCloses.includes(2));
});

Deno.test("persistence bounds admission while one reconnect attempt is pending", async () => {
  let connections = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation, signal }) {
        connections += 1;
        if (generation === 1) {
          return databaseGeneration(1, {
            query: () => Promise.reject(connectionError()),
          });
        }
        return new Promise<CopilotzDatabase>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
    databaseRecovery: { waitMs: 5, retryAfterSeconds: 7 },
  });
  try {
    await assertRejects(() => persistence.database.query("fail"));
    await waitFor(() => connections === 2);
    const errors = await Promise.all([
      assertRejects(() => persistence.database.query("one")),
      assertRejects(() => persistence.database.query("two")),
      assertRejects(() => persistence.recovery!.admit()),
    ]);
    for (const error of errors) {
      assert(isCopilotzPersistenceError(error));
      assertEquals(error.code, "persistence_unavailable");
      assertEquals(error.retryAfterSeconds, 7);
    }
    assertEquals(connections, 2);
  } finally {
    await persistence.close();
  }
});

Deno.test("persistence fences successful results from an obsolete generation", async () => {
  const slow = deferred<readonly Record<string, unknown>[]>();
  const closes: number[] = [];
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        return databaseGeneration(generation, {
          query(sql) {
            if (generation > 1) return Promise.resolve([{ generation }]);
            if (sql === "slow") return slow.promise;
            return Promise.reject(connectionError());
          },
          close: () => {
            closes.push(generation);
          },
        });
      },
    },
    databaseRecovery: { waitMs: 100 },
  });
  try {
    const stale = persistence.database.query("slow");
    await Promise.resolve();
    await assertRejects(() => persistence.database.query("fail"));
    await persistence.recovery!.admit();
    slow.resolve([{ generation: 1 }]);
    const error = await assertRejects(() => stale);
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    await waitFor(() => closes.includes(1));
  } finally {
    await persistence.close();
  }
});

Deno.test("persistence never replays an indeterminate transaction callback", async () => {
  let callbacks = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        return databaseGeneration(generation, {
          async transaction(operation, query) {
            const result = await operation(Object.freeze({ query }));
            if (generation === 1) throw connectionError();
            return result;
          },
        });
      },
    },
    databaseRecovery: { waitMs: 100 },
  });
  try {
    const error = await assertRejects(() =>
      persistence.database.transaction(() => {
        callbacks += 1;
        return "committed-or-not";
      })
    );
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    assertEquals(callbacks, 1);
    await persistence.recovery!.admit();
    assertEquals(
      await persistence.database.transaction(() => {
        callbacks += 1;
        return "new-operation";
      }),
      "new-operation",
    );
    assertEquals(callbacks, 2);
  } finally {
    await persistence.close();
  }
});

Deno.test("persistence rotates an OminiPG Oxian session loss without replaying the active query", async () => {
  let connections = 0;
  let failedCalls = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        connections += 1;
        return databaseGeneration(generation, {
          async query(sql) {
            if (generation === 1 && sql === "in-flight") {
              failedCalls += 1;
              throw hypervisorSessionError("indeterminate");
            }
            return [{ generation }];
          },
        });
      },
    },
    databaseRecovery: { waitMs: 100 },
  });
  try {
    const error = await assertRejects(() =>
      persistence.database.query("in-flight")
    );
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    assertEquals(error.indeterminate, true);
    assertEquals(failedCalls, 1);

    await persistence.recovery!.admit();
    assertEquals(connections, 2);
    assertEquals(
      (await persistence.database.query<{ generation: number }>("next")).rows,
      [{ generation: 2 }],
    );
    assertEquals(failedCalls, 1);
  } finally {
    await persistence.close();
  }
});

Deno.test("persistence classifier excludes domain and constraint failures", () => {
  assertEquals(
    isPersistenceUnavailable(Object.assign(new Error("duplicate key"), {
      code: "23505",
    })),
    false,
  );
  assertEquals(
    isPersistenceUnavailable(Object.assign(new Error("invalid input"), {
      code: "22023",
    })),
    false,
  );
  assertEquals(
    isPersistenceUnavailable(Object.assign(new Error("server shutdown"), {
      code: "57P01",
    })),
    true,
  );
  assertEquals(
    isPersistenceUnavailable(new Error("Ominipg session is closed")),
    true,
  );
  for (
    const code of [
      "connection_lost",
      "indeterminate",
      "worker_unavailable",
      "shutting_down",
    ] as const
  ) {
    assertEquals(isPersistenceUnavailable(hypervisorSessionError(code)), true);
    assertEquals(
      isPersistenceUnavailable(
        new Error("Ominipg session failed", {
          cause: hypervisorSessionError(code),
        }),
      ),
      true,
    );
  }
  assertEquals(
    isPersistenceUnavailable(Object.assign(new Error("domain outcome"), {
      code: "indeterminate",
    })),
    false,
  );
});

Deno.test("injected persistence remains caller-owned and is never replaced", async () => {
  let closes = 0;
  const database = databaseGeneration(1, {
    close: () => {
      closes += 1;
    },
  });
  const persistence = await openCopilotzPersistence({ database });
  assertEquals(persistence.ownership, "injected");
  assertEquals(persistence.recovery, undefined);
  await persistence.close();
  assertEquals(closes, 0);
  await database.close();
  assertEquals(closes, 1);
});

Deno.test("explicit roles share one stable persistence without taking its ownership", async () => {
  let closes = 0;
  const shared = await createCopilotzPersistence({
    database: {
      connect: () =>
        databaseGeneration(1, {
          close: () => {
            closes += 1;
          },
        }),
    },
  });
  const role = await openCopilotzPersistence({ persistence: shared });
  assertEquals(shared.ownership, "application");
  assertEquals(role.ownership, "injected");
  assertEquals(role.database, shared.database);
  assertEquals(role.recovery, shared.recovery);
  assertEquals("session" in shared, false);
  await role.close();
  assertEquals(closes, 0);
  await shared.close();
  assertEquals(closes, 1);

  await assertRejects(
    () => openCopilotzPersistence({ persistence: shared, database: {} }),
    TypeError,
    "Shared persistence cannot be combined",
  );
});
