import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { SqlExecutor, SqlSnapshotCleanup } from "../events/session.ts";
import { openCopilotzPersistence } from "./lifecycle.ts";
import {
  createOminipgSqlSession,
  type OminipgDatabaseLike,
} from "./ominipg.ts";
import { retireSnapshotDatabase } from "./snapshot-admission.ts";

const latch = () => Promise.withResolvers<void>();
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fake(options: {
  opening?: Promise<void>;
  opened?: () => void;
  cleaning?: () => void;
  cleanup?: Promise<void>;
  reports?: readonly SqlSnapshotCleanup[];
} = {}) {
  let opens = 0, closes = 0;
  const query: SqlExecutor["query"] = async (sql) => {
    await Promise.resolve();
    if (sql === "fail") {
      throw Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      });
    }
    return { rows: [] };
  };
  const database: OminipgDatabaseLike = {
    query,
    transaction: async (operation) => await operation({ query }),
    async withReadSnapshot(operation, config) {
      opens++;
      options.opened?.();
      try {
        await options.opening;
        config?.signal?.throwIfAborted();
        const value = await operation({
          kind: "exclusive",
          snapshot: { query },
        });
        config?.signal?.throwIfAborted();
        return value;
      } finally {
        options.cleaning?.();
        await options.cleanup;
        for (const report of options.reports ?? ["confirmed"]) {
          config?.onCleanup?.(report);
        }
      }
    },
    close() {
      closes++;
      return Promise.resolve();
    },
  };
  return {
    database,
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
  };
}
function snapshot(db: OminipgDatabaseLike) {
  return createOminipgSqlSession(db).withReadSnapshot!;
}
function unavailable(error: unknown) {
  assertEquals((error as { code: string }).code, "persistence_unavailable");
  assertEquals((error as { status: number }).status, 503);
  assertEquals((error as { retryAfterSeconds: number }).retryAfterSeconds, 1);
  assertEquals(
    (error as Error).message,
    "Application persistence is temporarily unavailable.",
  );
}

Deno.test("one physical session refuses concurrent and nested calls across attachments", async () => {
  const db = fake(), other = fake();
  const first = snapshot(db.database), second = snapshot(db.database);
  await first(async () => {
    unavailable(await assertRejects(() => second(() => Promise.resolve(2))));
    assertEquals(await snapshot(other.database)(() => Promise.resolve(3)), 3);
  });
  assertEquals(await second(() => Promise.resolve(4)), 4);
  assertEquals(db.opens, 2);
  const reason = new Error("already cancelled");
  assertStrictEquals(
    await assertRejects(() =>
      first(() => Promise.resolve(0), {
        signal: AbortSignal.abort(reason),
      })
    ),
    reason,
  );
  assertEquals(db.opens, 2);
});

Deno.test("cancellation retains physical capacity through late open and held raw cleanup", async () => {
  const opening = latch(),
    cleanup = latch(),
    opened = latch(),
    cleaning = latch();
  const db = fake({
    opening: opening.promise,
    cleanup: cleanup.promise,
    opened: opened.resolve,
    cleaning: cleaning.resolve,
  });
  const read = snapshot(db.database);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const reports: SqlSnapshotCleanup[] = [];
  let callbacks = 0;
  const a = read(async () => {
    await Promise.resolve();
    callbacks++;
  }, { signal: controller.signal, onCleanup: (value) => reports.push(value) });
  const rejected = assertRejects(() => a);
  await opened.promise;
  unavailable(await assertRejects(() => read(() => Promise.resolve(2))));
  controller.abort(reason);
  await tick();
  assertEquals(db.opens, 1);
  assertEquals(reports, []);
  opening.resolve();
  await cleaning.promise;
  await tick();
  assertEquals(db.opens, 1);
  assertEquals(callbacks, 0);
  assertEquals(reports, []);
  cleanup.resolve();
  assertStrictEquals(await rejected, reason);
  assertEquals(
    await read(() => {
      callbacks++;
      return Promise.resolve(2);
    }),
    2,
  );
  assertEquals(reports, ["confirmed"]);
  assertEquals(callbacks, 1);
});

for (const reports of [[], ["unknown"], ["confirmed", "confirmed"]] as const) {
  Deno.test(`cleanup ${JSON.stringify(reports)} quarantines exact identity and preserves settled outcome`, async () => {
    const release = latch(), entered = latch();
    const db = fake({ reports });
    const read = snapshot(db.database);
    const observed: SqlSnapshotCleanup[] = [];
    const a = read(async () => {
      entered.resolve();
      await release.promise;
      return 42;
    }, { onCleanup: (value) => observed.push(value) });
    await entered.promise;
    const b = read(async () => await Promise.resolve(99));
    const refused = assertRejects(() => b);
    release.resolve();
    assertEquals(await a, 42);
    unavailable(await refused);
    assertEquals(observed, ["unknown"]);
    assertEquals(db.opens, 1);
    unavailable(
      await assertRejects(() =>
        snapshot(db.database)(async () => await Promise.resolve(99))
      ),
    );
    assertEquals(db.opens, 1);
  });
}

Deno.test("quarantine preserves the operation's original error and ignores observer failure", async () => {
  const db = fake({ reports: [] });
  const expected = new Error("domain failure");
  assertStrictEquals(
    await assertRejects(() =>
      snapshot(db.database)(async () => {
        await Promise.resolve();
        throw expected;
      }, {
        onCleanup() {
          throw new Error("observer");
        },
      })
    ),
    expected,
  );
  unavailable(
    await assertRejects(() =>
      snapshot(db.database)(async () => await Promise.resolve(2))
    ),
  );
});

Deno.test("borrowed attachment close cancels only its own active calls, drains raw cleanup, and preserves database", async () => {
  const cleanup = latch(),
    cleaning = latch(),
    entered = latch(),
    release = latch();
  const db = fake({ cleanup: cleanup.promise, cleaning: cleaning.resolve });
  const a = await openCopilotzPersistence({ database: db.database });
  const b = await openCopilotzPersistence({ database: db.database });
  const first = a.session.withReadSnapshot!(async () => {
    entered.resolve();
    await release.promise;
  });
  const failed = assertRejects(() => first);
  await entered.promise;
  const own = a.session.withReadSnapshot!(async () => await Promise.resolve(1));
  const ownFailed = assertRejects(() => own);
  unavailable(
    await assertRejects(() =>
      b.session.withReadSnapshot!(() => Promise.resolve(2))
    ),
  );
  let closed = false;
  const closing = a.close();
  assertStrictEquals(a.close(), closing);
  closing.then(() => {
    closed = true;
  });
  unavailable(await ownFailed);
  await tick();
  assertEquals(closed, false);
  assertEquals(db.closes, 0);
  release.resolve();
  await cleaning.promise;
  await tick();
  assertEquals(db.opens, 1);
  assertEquals(closed, false);
  cleanup.resolve();
  unavailable(await failed);
  await closing;
  assertEquals(await b.session.withReadSnapshot!(() => Promise.resolve(2)), 2);
  unavailable(
    await assertRejects(() =>
      a.session.withReadSnapshot!(async () => await Promise.resolve(3))
    ),
  );
  assertEquals(db.closes, 0);
  await b.close();
  assertEquals(db.closes, 0);
});

Deno.test("owned retirement rejects new calls and waits the raw backend settlement", async () => {
  const cleanup = latch(), entered = latch(), release = latch();
  const db = fake({ cleanup: cleanup.promise });
  const read = snapshot(db.database);
  const first = read(async () => {
    entered.resolve();
    await release.promise;
  });
  const failed = assertRejects(() => first);
  await entered.promise;
  const next = read(async () => await Promise.resolve(2));
  const rejected = assertRejects(() => next);
  let done = false;
  const retire = retireSnapshotDatabase(db.database);
  retire.then(() => {
    done = true;
  });
  unavailable(await rejected);
  unavailable(
    await assertRejects(() => read(async () => await Promise.resolve(3))),
  );
  release.resolve();
  await tick();
  assertEquals(done, false);
  cleanup.resolve();
  unavailable(await failed);
  await retire;
  assertEquals(done, true);
  assertEquals(db.opens, 1);
});

Deno.test("unknown physical cleanup retires recoverable generation but preserves value and lets a new identity progress", async () => {
  const generations: ReturnType<typeof fake>[] = [];
  const p = await openCopilotzPersistence({
    database: {
      connect({ generation }) {
        const db = fake({ reports: generation === 1 ? [] : ["confirmed"] });
        generations.push(db);
        return db.database;
      },
    },
  });
  const reports: SqlSnapshotCleanup[] = [];
  try {
    assertEquals(
      await p.session.withReadSnapshot!(async () => await Promise.resolve(42), {
        onCleanup: (value) => reports.push(value),
      }),
      42,
    );
    assertEquals(reports, ["unknown"]);
    await p.recovery!.admit();
    assertEquals(
      await p.session.withReadSnapshot!(async () => await Promise.resolve(43)),
      43,
    );
    assertEquals(p.recovery!.snapshot().generation, 2);
    assertEquals(generations[0].opens, 1);
    assertEquals(generations[1].opens, 1);
    unavailable(
      await assertRejects(() =>
        snapshot(generations[0].database)(async () => await Promise.resolve(0))
      ),
    );
  } finally {
    await p.close();
  }
});

Deno.test("replacement physical generation proceeds while cancelled old generation retains raw cleanup", async () => {
  const opened = latch(), opening = latch(), cleanup = latch();
  const old = fake({
    opened: opened.resolve,
    opening: opening.promise,
    cleanup: cleanup.promise,
  });
  const next = fake();
  const p = await openCopilotzPersistence({
    database: {
      connect: ({ generation }) =>
        generation === 1 ? old.database : next.database,
    },
  });
  const first = p.session.withReadSnapshot!(async () =>
    await Promise.resolve(1)
  );
  const failed = assertRejects(() => first);
  try {
    await opened.promise;
    const queued = p.session.withReadSnapshot!(async () =>
      await Promise.resolve(2)
    );
    const refused = assertRejects(() => queued);
    await assertRejects(() => p.database.query("fail"));
    await refused;
    assertEquals(
      await p.session.withReadSnapshot!(async () => await Promise.resolve(3)),
      3,
    );
    assertEquals(old.opens, 1);
    assertEquals(old.closes, 0);
    assertEquals(next.opens, 1);
    opening.resolve();
    await tick();
    assertEquals(old.closes, 0);
    cleanup.resolve();
    await failed;
    await tick();
    assertEquals(old.closes, 1);
  } finally {
    opening.resolve();
    cleanup.resolve();
    await first.catch(() => {});
    await p.close();
  }
});

Deno.test("a cleanup confirmation never grants the next permit before the backend promise settles", async () => {
  const proof = latch(), settle = latch();
  const db = fake();
  const original = db.database.withReadSnapshot!;
  let calls = 0;
  const physical: OminipgDatabaseLike = {
    ...db.database,
    async withReadSnapshot(operation, options) {
      const call = ++calls;
      const value = await original(operation, options);
      if (call === 1) {
        proof.resolve();
        await settle.promise;
      }
      return value;
    },
  };
  const read = snapshot(physical);
  const first = read(() => Promise.resolve(1));
  await proof.promise;
  unavailable(await assertRejects(() => read(() => Promise.resolve(2))));
  await tick();
  assertEquals(calls, 1);
  settle.resolve();
  assertEquals(await first, 1);
  assertEquals(await read(() => Promise.resolve(2)), 2);
});

Deno.test("logical generation delegates share the raw physical gate and borrowed logical close stays local", async () => {
  const db = fake();
  const p = await openCopilotzPersistence({
    database: { connect: () => db.database },
  });
  const borrowed = await openCopilotzPersistence({ persistence: p });
  const other = await openCopilotzPersistence({ persistence: p });
  const entered = latch(), release = latch();
  const order: number[] = [];
  const first = snapshot(db.database)(async () => {
    entered.resolve();
    await release.promise;
    order.push(1);
  });
  await entered.promise;
  const cancelled = borrowed.session.withReadSnapshot!(() =>
    Promise.resolve(0)
  );
  const refused = assertRejects(() => cancelled);
  unavailable(
    await assertRejects(() =>
      other.session.withReadSnapshot!(() => Promise.resolve(2))
    ),
  );
  unavailable(
    await assertRejects(() =>
      p.database.withReadSnapshot!(() => Promise.resolve(3))
    ),
  );
  try {
    await borrowed.close();
    unavailable(await refused);
    assertEquals(db.opens, 1);
    assertEquals(db.closes, 0);
    release.resolve();
    await first;
    assertEquals(
      await other.session.withReadSnapshot!(() => Promise.resolve(2)),
      2,
    );
    assertEquals(
      await p.database.withReadSnapshot!(() => Promise.resolve(3)),
      3,
    );
    assertEquals(order, [1]);
    assertEquals(p.recovery!.snapshot().generation, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([first]);
    await other.close();
    await p.close();
  }
  assertEquals(db.closes, 1);
});
