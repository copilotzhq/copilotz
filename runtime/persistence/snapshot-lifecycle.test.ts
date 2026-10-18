import { assertEquals, assertRejects } from "@std/assert";
import {
  createSqlSession,
  type SqlExecutor,
  type SqlReadSnapshot,
} from "../events/session.ts";
import {
  isCopilotzPersistenceError,
  openCopilotzPersistence,
} from "./lifecycle.ts";
import type { OminipgDatabaseLike } from "./ominipg.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function connectionError() {
  return Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
}
function generation(
  id: number,
  events: string[],
  options: {
    readGate?: Promise<void>;
    cleanupGate?: Promise<void>;
    entered?: () => void;
  } = {},
): OminipgDatabaseLike {
  const query: SqlExecutor["query"] = <
    TRow extends Record<string, unknown>,
  >(sql: string) => {
    if (sql === "fail") return Promise.reject(connectionError());
    events.push(`query:${id}:${sql}`);
    return Promise.resolve({ rows: [{ generation: id }] as unknown as TRow[] });
  };
  return {
    query,
    transaction: async (operation) => await operation({ query }),
    withReadSnapshot: async (operation, config) => {
      const signal = config?.signal;
      signal?.throwIfAborted();
      events.push(`open:${id}`);
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      void aborted.catch(() => {});
      const abort = () => rejectAbort(signal?.reason);
      const pending = new Set<Promise<unknown>>();
      const track = <T>(value: Promise<T>): Promise<T> => {
        pending.add(value);
        void value.then(
          () => pending.delete(value),
          () => pending.delete(value),
        );
        return value;
      };
      const read: SqlExecutor["query"] = <TRow extends Record<string, unknown>>(
        sql: string,
      ) => {
        events.push(`read:${id}:${sql}`);
        options.entered?.();
        return track((async () => {
          if (sql === "held") await options.readGate;
          return { rows: [{ generation: id }] as unknown as TRow[] };
        })());
      };
      const scope: SqlReadSnapshot = {
        kind: "pooled",
        snapshot: { query: read },
        current: async (callback) => await track(callback({ query: read })),
      };
      try {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        return await Promise.race([operation(scope), aborted]);
      } finally {
        await Promise.allSettled([...pending]);
        await options.cleanupGate;
        events.push(`cleanup:${id}`);
        signal?.removeEventListener("abort", abort);
      }
    },
    close() {
      events.push(`close:${id}`);
      return Promise.resolve();
    },
  };
}
Deno.test("SQL session forwards scoped capability while preserving short snapshot selection", async () => {
  const events: string[] = [];
  const db = generation(1, events);
  const session = createSqlSession(db);
  assertEquals(
    await session.withReadSnapshot!(async (scope) =>
      (await scope.snapshot.query("scoped")).rows
    ),
    [{ generation: 1 }],
  );
  await session.readSnapshot!(async (tx) => {
    await tx.query("short");
  });
  assertEquals(events.includes("open:1"), true);
  assertEquals(
    events.includes(
      "query:1:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ),
    true,
  );
  const { withReadSnapshot: _capability, ...ordinary } = db;
  assertEquals(createSqlSession(ordinary).withReadSnapshot, undefined);
});
Deno.test("managed default PGlite exposes the operational snapshot capability", async () => {
  const persistence = await openCopilotzPersistence({});
  try {
    assertEquals(
      await persistence.session.withReadSnapshot!(async (scope) => {
        assertEquals(scope.kind, "exclusive");
        return (await scope.snapshot.query("SELECT 42 AS value")).rows;
      }),
      [{ value: 42 }],
    );
  } finally {
    await persistence.close();
  }
});
Deno.test("generation retirement suppresses held read output and retains old resource until raw cleanup", async () => {
  const events: string[] = [];
  const read = gate(), cleanup = gate(), entered = gate();
  let connects = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation: id }) {
        connects++;
        return generation(
          id,
          events,
          id === 1
            ? {
              readGate: read.promise,
              cleanupGate: cleanup.promise,
              entered: entered.resolve,
            }
            : {},
        );
      },
    },
  });
  let retained: SqlExecutor | undefined;
  let work: Promise<unknown> | undefined;
  try {
    work = persistence.session.withReadSnapshot!(async (scope) => {
      retained = scope.snapshot;
      return await scope.snapshot.query("held");
    });
    const observed = work.catch((error) => error);
    await entered.promise;
    await assertRejects(() => persistence.database.query("fail"));
    assertEquals((await persistence.database.query("replacement")).rows, [{
      generation: 2,
    }]);
    assertEquals(connects, 2);
    await assertRejects(() => retained!.query("late"));
    assertEquals(events.includes("read:1:late"), false);
    assertEquals(events.includes("close:1"), false);
    read.resolve();
    await Promise.resolve();
    assertEquals(events.includes("close:1"), false);
    cleanup.resolve();
    const error = await observed;
    if (!isCopilotzPersistenceError(error)) {
      throw new Error("Expected generation failure", { cause: error });
    }
    assertEquals(error.generation, 1);
    assertEquals(events.indexOf("cleanup:1") < events.indexOf("close:1"), true);
    assertEquals(events.filter((event) => event === "open:1").length, 1);
    assertEquals(events.includes("open:2"), false);
  } finally {
    read.resolve();
    cleanup.resolve();
    await work?.catch(() => {});
    await persistence.close();
  }
});
Deno.test("current-state callback result is fenced when its generation retires", async () => {
  const events: string[] = [];
  const entered = gate(), release = gate();
  const persistence = await openCopilotzPersistence({
    database: { connect: ({ generation: id }) => generation(id, events) },
  });
  let current: Promise<unknown> | undefined, work: Promise<unknown> | undefined;
  try {
    work = persistence.session.withReadSnapshot!(async (scope) => {
      if (scope.kind !== "pooled") throw new Error("Expected control lane");
      current = scope.current(async () => {
        entered.resolve();
        await release.promise;
        return 42;
      });
      return await current;
    });
    const observed = work.catch((error) => error);
    await entered.promise;
    await assertRejects(() => persistence.database.query("fail"));
    assertEquals((await persistence.database.query("replacement")).rows, [{
      generation: 2,
    }]);
    const retained = current!.catch((error) => error);
    release.resolve();
    assertEquals(isCopilotzPersistenceError(await retained), true);
    assertEquals(isCopilotzPersistenceError(await observed), true);
  } finally {
    release.resolve();
    await work?.catch(() => {});
    await persistence.close();
  }
});
Deno.test("captured local cancellation does not reconnect based on its error wording", async () => {
  const events: string[] = [];
  const entered = gate(), release = gate();
  const first = new AbortController(), other = new AbortController();
  const options = { signal: first.signal };
  let connects = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect: ({ generation: id }) => {
        connects++;
        return generation(id, events);
      },
    },
  });
  const reason = new Error("connection closed");
  const work = persistence.session.withReadSnapshot!(async () => {
    entered.resolve();
    await release.promise;
    return 42;
  }, options);
  const observed = work.catch((error) => error);
  try {
    await entered.promise;
    options.signal = other.signal;
    first.abort(reason);
    assertEquals(await observed, reason);
    assertEquals(connects, 1);
    assertEquals((await persistence.database.query("healthy")).rows, [{
      generation: 1,
    }]);
  } finally {
    release.resolve();
    await work.catch(() => {});
    await persistence.close();
  }
});
Deno.test("persistence close revokes snapshot admission but waits its actual cleanup", async () => {
  const events: string[] = [];
  const entered = gate(), release = gate(), cleanup = gate();
  const persistence = await openCopilotzPersistence({
    database: {
      connect: ({ generation: id }) =>
        generation(id, events, { cleanupGate: cleanup.promise }),
    },
  });
  const work = persistence.session.withReadSnapshot!(async () => {
    entered.resolve();
    await release.promise;
    return 42;
  });
  const observed = work.catch((error) => error);
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    let done = false;
    closing = persistence.close().then(() => {
      done = true;
    });
    await Promise.resolve();
    assertEquals(done, false);
    assertEquals(events.includes("close:1"), false);
    cleanup.resolve();
    assertEquals(isCopilotzPersistenceError(await observed), true);
    await closing;
    assertEquals(events.indexOf("cleanup:1") < events.indexOf("close:1"), true);
  } finally {
    release.resolve();
    cleanup.resolve();
    await work.catch(() => {});
    await closing;
    await persistence.close();
  }
});
Deno.test("missing scoped capability refuses without fallback or generation replacement", async () => {
  const events: string[] = [];
  let connects = 0, called = false;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation: id }) {
        connects++;
        const { withReadSnapshot: _capability, ...ordinary } = generation(
          id,
          events,
        );
        return ordinary;
      },
    },
  });
  try {
    await assertRejects(
      () =>
        persistence.session.withReadSnapshot!(() => {
          called = true;
          return Promise.resolve(42);
        }),
      Error,
      "does not support scoped snapshots",
    );
    assertEquals(called, false);
    assertEquals(connects, 1);
    assertEquals(events, []);
    assertEquals((await persistence.database.query("ordinary")).rows, [{
      generation: 1,
    }]);
  } finally {
    await persistence.close();
  }
});
const snapshotPgUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ??
  Deno.env.get("DB_URL_PG");
Deno.test({
  name:
    "managed PostgreSQL forwards independent current transactions without moving the snapshot",
  ignore: !snapshotPgUrl,
  async fn() {
    const persistence = await openCopilotzPersistence({
      database: { url: snapshotPgUrl!, pgPoolMax: 2 },
    });
    try {
      await persistence.database.query(
        "CREATE TABLE generation_snapshot_probe(value integer)",
      );
      await persistence.database.query(
        "INSERT INTO generation_snapshot_probe VALUES(10)",
      );
      const value = await persistence.session.withReadSnapshot!(
        async (scope) => {
          if (scope.kind !== "pooled") {
            throw new Error("Expected pooled resource");
          }
          assertEquals(
            (await scope.snapshot.query(
              "SELECT value FROM generation_snapshot_probe",
            )).rows,
            [{ value: 10 }],
          );
          await scope.current(async (tx) => {
            await tx.query("UPDATE generation_snapshot_probe SET value=20");
          });
          assertEquals(
            (await scope.snapshot.query(
              "SELECT value FROM generation_snapshot_probe",
            )).rows,
            [{ value: 10 }],
          );
          return 42;
        },
      );
      assertEquals(value, 42);
      assertEquals(
        (await persistence.database.query(
          "SELECT value FROM generation_snapshot_probe",
        )).rows,
        [{ value: 20 }],
      );
      assertEquals(persistence.recovery?.snapshot().generation, 1);
      await persistence.database.query("DROP TABLE generation_snapshot_probe");
    } finally {
      await persistence.close();
    }
  },
});

Deno.test("caller cancellation after backend settlement suppresses final snapshot value", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled at facade boundary");
  const events: string[] = [];
  let connects = 0;
  const persistence = await openCopilotzPersistence({
    database: {
      connect({ generation: id }) {
        connects++;
        const db = generation(id, events);
        return {
          ...db,
          async withReadSnapshot<T>(
            operation: (scope: SqlReadSnapshot) => Promise<T>,
          ) {
            const value = await db.withReadSnapshot!(operation);
            queueMicrotask(() => controller.abort(reason));
            return value;
          },
        };
      },
    },
  });
  try {
    const error = await assertRejects(() =>
      persistence.session.withReadSnapshot!(
        () => Promise.resolve(42),
        { signal: controller.signal },
      )
    );
    assertEquals(error, reason);
    assertEquals(connects, 1);
  } finally {
    await persistence.close();
  }
});

Deno.test("final caller signal preflight cannot retire generation after the last witness", async () => {
  const controller = new AbortController();
  const persistence = await openCopilotzPersistence({
    database: { connect: ({ generation: id }) => generation(id, []) },
  });
  let checks = 0;
  let closing: Promise<void> | undefined;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value() {
      checks++;
      if (checks === 2) closing = persistence.close();
    },
  });
  try {
    const error = await assertRejects(() =>
      persistence.session.withReadSnapshot!(
        () => Promise.resolve(42),
        { signal: controller.signal },
      )
    );
    assertEquals(isCopilotzPersistenceError(error), true);
    assertEquals(checks, 2);
  } finally {
    await closing;
    await persistence.close();
  }
});
