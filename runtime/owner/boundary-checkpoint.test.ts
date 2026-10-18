import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCheckpointHandler,
  type OwnerCommandBoundaryOptions,
} from "./boundary.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const caller: OwnerCaller = {
  principal: { kind: "worker", workerId: "worker" },
  ownerEpoch: 1,
  authenticated: true,
};
function options(
  session: SqlSession,
  extra: Partial<OwnerCommandBoundaryOptions> = {},
): OwnerCommandBoundaryOptions {
  return {
    session,
    schema: "public",
    ownerId: "tenant",
    holderId: "holder",
    handlers: { put: () => ({ ok: true }) },
    checkpoints: { offset: writeOffset },
    projections: { read: () => ({ ok: true }) },
    authorize(_tx, who) {
      if (who.authenticated !== true) throw new Error("unauthorized");
    },
    authenticateReceipt() {},
    isCurrentAuthorization: () => true,
    ...extra,
  };
}
// Boundary fixture only. Production stream handlers additionally prove exact
// attempt/binding/generation and owner-observed physical evidence.
const writeOffset: OwnerCheckpointHandler = async (input, context) => {
  const { start, end } = input as { start: number; end: number };
  const previous = (await context.tx.query<{ offset: string }>(
    "SELECT data->>'offset' AS offset FROM public.nodes WHERE id='checkpoint' FOR UPDATE",
  )).rows[0];
  const offset = previous ? Number(previous.offset) : 0;
  if (offset === end) return { offset };
  if (offset !== start) throw new Error("checkpoint conflict");
  await context.tx.query(
    `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('checkpoint','tenant','fixture','checkpoint',jsonb_build_object('offset',$1::integer)) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`,
    [end],
  );
  return { offset: end };
};
async function fixture(run: (db: TestDatabase) => Promise<void>) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    await run(db);
  } finally {
    await db.close();
  }
}
async function storedOffset(db: SqlExecutor) {
  return (await db.query<{ offset: string }>(
    "SELECT data->>'offset' AS offset FROM public.nodes WHERE id='checkpoint'",
  )).rows[0]?.offset;
}
async function counts(db: SqlExecutor) {
  const result: Record<string, number> = {};
  for (const table of ["owner_receipts", "owner_receipt_readers", "events"]) {
    result[table] = (await db.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM public.${table}`,
    )).rows[0].n;
  }
  return result;
}

Deno.test("receipt-free checkpoints share owner SQL fencing but create no receipt or sequence event", () =>
  fixture(async (db) => {
    const statements: string[] = [];
    const session: SqlSession = {
      query: db.query,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: (sql, params) => {
              statements.push(sql);
              return tx.query(sql, params);
            },
          })
        ),
    };
    const owner = createOwnerCommandBoundary(options(session));
    await owner.acquire(0);
    statements.length = 0;
    try {
      assertEquals(
        await owner.checkpoint(caller, "offset", { start: 0, end: 3 }),
        { offset: 3 },
      );
      assertEquals(
        await owner.checkpoint(caller, "offset", { start: 0, end: 3 }),
        { offset: 3 },
      );
      await assertRejects(
        () => owner.checkpoint(caller, "offset", { start: 0, end: 4 }),
        Error,
        "checkpoint conflict",
      );
      assertEquals(await storedOffset(db), "3");
      assertEquals(await counts(db), {
        owner_receipts: 0,
        owner_receipt_readers: 0,
        events: 0,
      });
      assertEquals(
        statements.some((sql) =>
          /owner_receipts|owner_receipt_readers/.test(sql)
        ),
        false,
      );
      assertEquals(
        (await db.query<{ seq: string }>(
          "SELECT last_seq::text AS seq FROM public.owner_epochs",
        )).rows,
        [{ seq: "0" }],
      );
    } finally {
      owner.stop();
    }
  }));

Deno.test("checkpoint registration requires a scoped lifetime fence and disjoint dispatch routes", () =>
  fixture(async (db) => {
    assertThrows(
      () =>
        createOwnerCommandBoundary(
          options(db, { isCurrentAuthorization: undefined }),
        ),
      TypeError,
      "authorization fence",
    );
    assertThrows(
      () =>
        createOwnerCommandBoundary(
          options(db, { currentAuthorizationKinds: ["put"] }),
        ),
      TypeError,
      "Every owner checkpoint",
    );
    assertThrows(
      () =>
        createOwnerCommandBoundary(
          options(db, { checkpoints: { put: writeOffset } }),
        ),
      TypeError,
      "distinct",
    );
    assertThrows(
      () =>
        createOwnerCommandBoundary(
          options(db, { checkpoints: { read: writeOffset } }),
        ),
      TypeError,
      "distinct",
    );
    const owner = createOwnerCommandBoundary(
      options(db, { currentAuthorizationKinds: ["offset"] }),
    );
    await owner.acquire(0);
    try {
      await assertRejects(() =>
        owner.execute(caller, {
          kind: "offset",
          domain: "logical",
          key: "forged",
          intent: { start: 0, end: 1 },
        })
      );
      await assertRejects(() =>
        owner.executeInput(caller, {
          kind: "offset",
          domain: "logical",
          key: "forged",
          input: { start: 0, end: 1 },
        })
      );
      await assertRejects(() =>
        owner.project(caller, "offset", { start: 0, end: 1 })
      );
      await assertRejects(() => owner.checkpoint(caller, "put", {}));
      await assertRejects(() => owner.checkpoint(caller, "read", {}));
      assertEquals(await storedOffset(db), undefined);
    } finally {
      owner.stop();
    }
  }));

Deno.test("checkpoint revocation before commit rolls back its write and publication", () =>
  fixture(async (db) => {
    let current = true;
    let publications = 0;
    const started = deferred();
    const release = deferred();
    const owner = createOwnerCommandBoundary(
      options(db, {
        isCurrentAuthorization: () => current,
        checkpoints: {
          offset: async (input, context) => {
            const result = await writeOffset(input, context);
            context.afterCommit(() => {
              publications++;
            });
            started.resolve();
            await release.promise;
            return result;
          },
        },
      }),
    );
    await owner.acquire(0);
    try {
      const pending = owner.checkpoint(caller, "offset", { start: 0, end: 1 });
      const rejected = assertRejects(() => pending);
      await started.promise;
      current = false;
      release.resolve();
      await rejected;
      assertEquals(await storedOffset(db), undefined);
      assertEquals(publications, 0);
      assertEquals(await counts(db), {
        owner_receipts: 0,
        owner_receipt_readers: 0,
        events: 0,
      });
    } finally {
      release.resolve();
      owner.stop();
    }
  }));

Deno.test("checkpoint post-commit revocation hides reply while preserving committed state and callback", () =>
  fixture(async (db) => {
    let current = true;
    let armed = false;
    const published = deferred();
    const session: SqlSession = {
      query: db.query,
      transaction: async (fn) => {
        const result = await db.transaction(fn);
        if (armed) current = false;
        return result;
      },
    };
    const owner = createOwnerCommandBoundary(options(session, {
      isCurrentAuthorization: () => current,
      checkpoints: {
        offset: async (input, context) => {
          const result = await writeOffset(input, context);
          context.afterCommit(() => published.resolve());
          return result;
        },
      },
    }));
    await owner.acquire(0);
    armed = true;
    try {
      await assertRejects(() =>
        owner.checkpoint(caller, "offset", { start: 0, end: 2 })
      );
      await published.promise;
      assertEquals(await storedOffset(db), "2");
      assertEquals(await counts(db), {
        owner_receipts: 0,
        owner_receipt_readers: 0,
        events: 0,
      });
    } finally {
      owner.stop();
    }
  }));

Deno.test("checkpoint unknown commit stops holder without automatic replay or fabricated receipt", () =>
  fixture(async (db) => {
    let armed = false;
    let calls = 0;
    let callbacks = 0;
    const session: SqlSession = {
      query: db.query,
      transaction: async (fn) => {
        const result = await db.transaction(fn);
        if (armed) throw new Error("simulated lost COMMIT response");
        return result;
      },
    };
    const owner = createOwnerCommandBoundary(
      options(session, {
        checkpoints: {
          offset: async (input, context) => {
            calls++;
            const result = await writeOffset(input, context);
            context.afterCommit(() => {
              callbacks++;
            });
            return result;
          },
        },
      }),
    );
    await owner.acquire(0);
    armed = true;
    try {
      await assertRejects(
        () => owner.checkpoint(caller, "offset", { start: 0, end: 5 }),
        Error,
        "outcome is unknown",
      );
      assertEquals(owner.state, "stopped");
      assertEquals(calls, 1);
      assertEquals(callbacks, 0);
      assertEquals(await storedOffset(db), "5");
      assertEquals(await counts(db), {
        owner_receipts: 0,
        owner_receipt_readers: 0,
        events: 0,
      });
    } finally {
      owner.stop();
    }
  }));

Deno.test("checkpoints share admission capacity and close their scoped SQL executor", () =>
  fixture(async (db) => {
    const started = deferred();
    const release = deferred();
    let retained: SqlExecutor | undefined;
    let contextKeys: string[] = [];
    const owner = createOwnerCommandBoundary(options(db, {
      maxQueue: 1,
      checkpoints: {
        offset: async (input, context) => {
          retained = context.tx;
          contextKeys = Object.keys(context).sort();
          started.resolve();
          await release.promise;
          return await writeOffset(input, context);
        },
      },
    }));
    await owner.acquire(0);
    try {
      const pending = owner.checkpoint(caller, "offset", { start: 0, end: 1 });
      await started.promise;
      await assertRejects(
        () =>
          owner.execute(caller, {
            kind: "put",
            domain: "logical",
            key: "queued",
            intent: {},
          }),
        Error,
        "capacity",
      );
      release.resolve();
      await pending;
      await assertRejects(
        () => retained!.query("SELECT 1"),
        Error,
        "no longer active",
      );
      assertEquals(contextKeys, [
        "afterCommit",
        "caller",
        "commandTime",
        "ownerCommit",
        "signal",
        "tx",
      ]);
      assertEquals(
        (await owner.execute(caller, {
          kind: "put",
          domain: "logical",
          key: "after",
          intent: {},
        })).status,
        "committed",
      );
      assertEquals(await counts(db), {
        owner_receipts: 1,
        owner_receipt_readers: 1,
        events: 0,
      });
    } finally {
      release.resolve();
      owner.stop();
    }
  }));

Deno.test("checkpoint cancellation after commit suppresses response even when private fence remains true", () =>
  fixture(async (db) => {
    let armed = false;
    const abort = new AbortController();
    const session: SqlSession = {
      query: db.query,
      transaction: async (fn) => {
        const result = await db.transaction(fn);
        if (armed) abort.abort(new Error("cancelled after commit"));
        return result;
      },
    };
    const owner = createOwnerCommandBoundary(options(session));
    await owner.acquire(0);
    armed = true;
    try {
      await assertRejects(
        () =>
          owner.checkpoint(caller, "offset", { start: 0, end: 7 }, {
            signal: abort.signal,
          }),
        Error,
        "cancelled after commit",
      );
      assertEquals(await storedOffset(db), "7");
      assertEquals(await counts(db), {
        owner_receipts: 0,
        owner_receipt_readers: 0,
        events: 0,
      });
    } finally {
      owner.stop();
    }
  }));

Deno.test("later grouped command revocation rolls back checkpoint before isolated retries", () =>
  fixture(async (db) => {
    let current = true;
    const executed: string[] = [];
    const publications: string[] = [];
    const published = deferred();
    const owner = createOwnerCommandBoundary(options(db, {
      isCurrentAuthorization: (_tx, _who, command) =>
        command.kind === "revoke" || current,
      checkpoints: {
        offset: async (input, context) => {
          executed.push("checkpoint");
          const result = await writeOffset(input, context);
          context.afterCommit(() => {
            publications.push("checkpoint");
          });
          return result;
        },
      },
      handlers: {
        revoke: async (_input, context) => {
          executed.push("revoke");
          current = false;
          await context.tx.query(
            `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('revocation','tenant','fixture','revocation','{}')`,
          );
          context.afterCommit(() => {
            publications.push("revoke");
            published.resolve();
          });
          return { ok: true };
        },
      },
    }));
    await owner.acquire(0);
    try {
      const results = await Promise.allSettled([
        owner.checkpoint(caller, "offset", { start: 0, end: 4 }),
        owner.execute(caller, {
          kind: "revoke",
          domain: "logical",
          key: "revoke",
          intent: {},
        }),
      ]);
      assertEquals(results.map((r) => r.status), ["rejected", "fulfilled"]);
      await published.promise;
      assertEquals(executed, ["checkpoint", "revoke", "revoke"]);
      assertEquals(publications, ["revoke"]);
      assertEquals(await storedOffset(db), undefined);
      assertEquals(await counts(db), {
        owner_receipts: 1,
        owner_receipt_readers: 1,
        events: 0,
      });
      assertEquals(
        (await db.query("SELECT key FROM public.owner_receipts")).rows,
        [{ key: "revoke" }],
      );
    } finally {
      owner.stop();
    }
  }));

Deno.test("known group rollback reruns checkpoint SQL alone without duplicate publication", () =>
  fixture(async (db) => {
    let armed = false;
    let injected = false;
    let checkpointCalls = 0;
    let publications = 0;
    const published = deferred();
    const session: SqlSession = {
      query: db.query,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: (sql, params) => {
              if (armed && !injected && sql === "SAVEPOINT owner_command_1") {
                injected = true;
                return Promise.reject(
                  new Error("confirmed pre-commit failure"),
                );
              }
              return tx.query(sql, params);
            },
          })
        ),
    };
    const owner = createOwnerCommandBoundary(options(session, {
      checkpoints: {
        offset: async (input, context) => {
          checkpointCalls++;
          const result = await writeOffset(input, context);
          context.afterCommit(() => {
            publications++;
            published.resolve();
          });
          return result;
        },
      },
    }));
    await owner.acquire(0);
    armed = true;
    try {
      const results = await Promise.all([
        owner.checkpoint(caller, "offset", { start: 0, end: 9 }),
        owner.execute(caller, {
          kind: "put",
          domain: "logical",
          key: "put",
          intent: {},
        }),
      ]);
      await published.promise;
      assertEquals(results[0], { offset: 9 });
      assertEquals(results[1].status, "committed");
      assertEquals(checkpointCalls, 2);
      assertEquals(publications, 1);
      assertEquals(await storedOffset(db), "9");
      assertEquals(await counts(db), {
        owner_receipts: 1,
        owner_receipt_readers: 1,
        events: 0,
      });
    } finally {
      owner.stop();
    }
  }));

for (const route of ["checkpoint", "command", "projection"] as const) {
  Deno.test(`final ${route} authorization cannot hide reentrant source cancellation`, () =>
    fixture(async (db) => {
      let armed = false;
      let committed = false;
      let callbacks = 0;
      const abort = new AbortController();
      const published = deferred();
      const session: SqlSession = {
        query: db.query,
        transaction: async (fn) => {
          const result = await db.transaction(fn);
          if (armed) committed = true;
          return result;
        },
      };
      const mutate: OwnerCheckpointHandler = async (input, context) => {
        const result = await writeOffset(input, context);
        context.afterCommit(() => {
          callbacks++;
          published.resolve();
        });
        return result;
      };
      const owner = createOwnerCommandBoundary(options(session, {
        isCurrentAuthorization() {
          if (committed) abort.abort(new Error("abort inside final fence"));
          return true;
        },
        checkpoints: { offset: mutate },
        handlers: { put: mutate },
        projections: { read: () => ({ ok: true }) },
      }));
      await owner.acquire(0);
      armed = true;
      try {
        const execution = { signal: abort.signal };
        const input = { start: 0, end: 1 };
        await assertRejects(
          () =>
            route === "checkpoint"
              ? owner.checkpoint(caller, "offset", input, execution)
              : route === "command"
              ? owner.execute(caller, {
                kind: "put",
                domain: "logical",
                key: "mutate",
                intent: input,
              }, execution)
              : owner.project(caller, "read", null, execution),
          Error,
          "abort inside final fence",
        );
        if (route !== "projection") await published.promise;
        assertEquals(
          await storedOffset(db),
          route === "projection" ? undefined : "1",
        );
        assertEquals(callbacks, route === "projection" ? 0 : 1);
        assertEquals(await counts(db), {
          owner_receipts: route === "command" ? 1 : 0,
          owner_receipt_readers: route === "command" ? 1 : 0,
          events: 0,
        });
      } finally {
        owner.stop();
      }
    }));
}
