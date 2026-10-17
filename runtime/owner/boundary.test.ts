import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandBoundaryOptions,
  type OwnerCommandHandler,
  type OwnerJson,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const caller = (ownerEpoch = 1, workerId = "worker-a"): OwnerCaller => ({
  workerId,
  ownerEpoch,
  authenticated: true,
});
const command = (
  key: string,
  intent: OwnerJson = { id: key },
  kind = "put",
): OwnerCommand => ({ kind, domain: "logical", key, intent });
const errorCode = (code: string) => (error: unknown): boolean =>
  !!error && typeof error === "object" &&
  (error as { code?: unknown }).code === code;

async function fixture(
  run: (db: TestDatabase) => Promise<void>,
  ownerSchema = true,
): Promise<void> {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    if (ownerSchema) await provisionOwnerCommandSchema(db, "public");
    await run(db);
  } finally {
    await db.close();
  }
}
const put: OwnerCommandHandler = async (intent, ctx) => {
  const id = (intent as { id: string }).id;
  await ctx.tx.query(
    `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES($1,'test','note',$1,'{"writes":1}')
    ON CONFLICT(id) DO UPDATE SET data=jsonb_build_object('writes',(nodes.data->>'writes')::int+1)`,
    [id],
  );
  return { recordIds: [id], eventIds: [] };
};
function options(
  session: SqlSession,
  extra: Partial<OwnerCommandBoundaryOptions> = {},
): OwnerCommandBoundaryOptions {
  return {
    session,
    schema: "public",
    ownerId: "tenant-a",
    holderId: "holder-a",
    handlers: { put },
    authorize(_tx, who) {
      if (who.authenticated !== true) throw new Error("not authorized");
    },
    authenticateReceipt(_tx, who) {
      if (who.authenticated !== true) throw new Error("not authenticated");
    },
    ...extra,
  };
}
async function nodeIds(db: SqlExecutor): Promise<string[]> {
  return (await db.query<{ id: string }>(
    "SELECT id FROM public.nodes ORDER BY id",
  )).rows.map((row) => row.id);
}

// The faults below exercise the SQL-session boundary over real PGlite transactions.
// They are explicit response-loss/rollback simulations, not distributed crash proof.
test("owner schema is explicit, fresh-only, and refuses unfenced legacy event inserts", async () => {
  await fixture(async (db) => {
    const owner = createOwnerCommandBoundary(options(db));
    await assert.rejects(
      owner.acquire(0),
      errorCode("owner_schema_not_provisioned"),
    );
    await db.query(
      `INSERT INTO public.events(id,schema_version,type,namespace,payload,correlation_id)
      VALUES('legacy',1,'note.created','test','{}','legacy')`,
    );
    await assert.rejects(
      provisionOwnerCommandSchema(db, "public"),
      errorCode("owner_schema_requires_empty_events"),
    );
  }, false);
  await fixture(async (db) => {
    await assert.rejects(
      db.query(
        `INSERT INTO public.events(id,schema_version,type,namespace,payload,correlation_id)
      VALUES('legacy',1,'note.created','test','{}','legacy')`,
      ),
      /copilotz_owner_events_required/,
    );
    assert.equal(
      (await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='events' AND column_name='position'",
      )).rows.length,
      1,
    );
    assert.equal(
      (await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name='owner_records'",
      )).rows.length,
      0,
    );
  });
});

test("internal owner schema admits one owner ID while retaining same-owner epoch takeover", async () => {
  await fixture(async (db) => {
    const first = createOwnerCommandBoundary(options(db));
    const conflicting = createOwnerCommandBoundary(options(db, {
      ownerId: "tenant-b",
      holderId: "holder-b",
    }));
    assert.equal(await first.acquire(0), 1);
    await assert.rejects(
      conflicting.acquire(0),
      errorCode("owner_schema_owner_conflict"),
    );
    assert.equal(conflicting.state, "stopped");
    await assert.rejects(
      conflicting.readReceipt(caller(), { domain: "logical", key: "step" }),
      errorCode("owner_schema_owner_conflict"),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO public.owner_epochs(owner,epoch,holder,last_seq) VALUES('tenant-b',1,'holder-b',0)",
      ),
      /owner_epochs_single_owner_idx/,
    );
    const successor = createOwnerCommandBoundary(options(db, {
      holderId: "holder-successor",
    }));
    assert.equal(await successor.acquire(1), 2);
    await assert.rejects(
      first.execute(caller(), command("stale")),
      errorCode("ActionOwnershipLost"),
    );
    assert.equal(
      (await successor.execute(caller(2), command("live"))).status,
      "committed",
    );
    assert.deepEqual(
      (await db.query("SELECT owner FROM public.owner_epochs")).rows,
      [{ owner: "tenant-a" }],
    );
  });
});

test("concurrent first acquisitions cannot install distinct owner IDs in one schema", async () => {
  await fixture(async (db) => {
    const owners = ["tenant-a", "tenant-b"].map((ownerId) =>
      createOwnerCommandBoundary(options(db, { ownerId }))
    );
    const results = await Promise.allSettled(
      owners.map((owner) => owner.acquire(0)),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const refused = results.find((result) => result.status === "rejected");
    assert.ok(refused?.status === "rejected");
    assert.ok(errorCode("owner_schema_owner_conflict")(refused.reason));
    assert.equal(
      (await db.query("SELECT 1 FROM public.owner_epochs")).rows.length,
      1,
    );
  });
});

test("owner operations reject a schema missing its internal single-owner guard", async () => {
  await fixture(async (db) => {
    await db.query("DROP INDEX IF EXISTS public.owner_epochs_single_owner_idx");
    const owner = createOwnerCommandBoundary(options(db));
    await assert.rejects(
      owner.acquire(0),
      errorCode("owner_schema_not_provisioned"),
    );
    await assert.rejects(
      owner.readReceipt(caller(), { domain: "logical", key: "step" }),
      errorCode("owner_schema_not_provisioned"),
    );
  });
});

test("grouped commands use independent savepoints and command timestamps, with atomic receipts", async () => {
  await fixture(async (db) => {
    const timestamps: string[] = [];
    const callbacks: string[] = [];
    let tick = 0;
    let transactions = 0;
    const session: SqlSession = {
      query: db.query,
      async transaction(operation) {
        transactions++;
        return await db.transaction(operation);
      },
    };
    const owner = createOwnerCommandBoundary(options(session, {
      now: () => `2026-10-16T23:00:0${tick++}.000Z`,
      authorize(_tx, _caller, _command, time) {
        timestamps.push(time);
      },
      handlers: {
        async put(intent, ctx) {
          assert.equal(ctx.ownerCommit.transaction, ctx.tx);
          assert.equal(ctx.ownerCommit.commandTime, ctx.commandTime);
          assert.equal(ctx.ownerCommit.ownerId, "tenant-a");
          const result = await put(intent, ctx);
          ctx.afterCommit(() => {
            callbacks.push(ctx.command.key);
          });
          if (ctx.command.key === "bad") throw new Error("command failure");
          return result;
        },
      },
    }));
    assert.equal(await owner.acquire(0), 1);
    transactions = 0;
    const outcomes = await Promise.allSettled(
      ["first", "bad", "last"].map((key) =>
        owner.execute(caller(), command(key))
      ),
    );
    assert.deepEqual(outcomes.map((outcome) => outcome.status), [
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    await Promise.resolve();
    assert.equal(transactions, 1);
    assert.deepEqual(await nodeIds(db), ["first", "last"]);
    assert.deepEqual(callbacks, ["first", "last"]);
    assert.equal(new Set(timestamps).size, 3);
    assert.deepEqual(
      (await db.query<{ key: string }>(
        "SELECT key FROM public.owner_receipts ORDER BY key",
      )).rows.map((row) => row.key),
      ["first", "last"],
    );
  });
});

test("duplicate identity compares canonical whole intent and kind, and rechecks current authorization", async () => {
  await fixture(async (db) => {
    let allowed = true;
    let authorizations = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: { put, other: put },
      authorize() {
        authorizations++;
        if (!allowed) throw new Error("revoked");
      },
    }));
    await owner.acquire(0);
    const first = await owner.execute(
      caller(),
      command("step", { id: "note", metadata: { a: 1, b: 2 } }),
    );
    assert.equal(first.status, "committed");
    const duplicate = await owner.execute(
      caller(),
      command("step", { metadata: { b: 2, a: 1 }, id: "note" }),
    );
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.result, first.result);
    await assert.rejects(
      owner.execute(caller(), command("step", { id: "different" })),
      errorCode("owner_intent_conflict"),
    );
    await assert.rejects(
      owner.execute(
        caller(),
        command("step", { id: "note", metadata: { a: 1, b: 2 } }, "other"),
      ),
      errorCode("owner_intent_conflict"),
    );
    allowed = false;
    await assert.rejects(
      owner.execute(
        caller(),
        command("step", { id: "note", metadata: { a: 1, b: 2 } }),
      ),
      /revoked/,
    );
    assert.equal(authorizations, 5);
    assert.equal(
      (await db.query<{ writes: number }>(
        "SELECT (data->>'writes')::int AS writes FROM nodes WHERE id='note'",
      )).rows[0].writes,
      1,
    );
  });
});

test("takeover fences old holders while authenticated same-worker receipt reads survive epochs", async () => {
  await fixture(async (db) => {
    const old = createOwnerCommandBoundary(options(db));
    await old.acquire(0);
    await old.execute(caller(), command("step"));
    const successor = createOwnerCommandBoundary(
      options(db, { holderId: "holder-b" }),
    );
    assert.equal(await successor.acquire(1), 2);
    await assert.rejects(
      old.execute(caller(), command("stale")),
      errorCode("ActionOwnershipLost"),
    );
    assert.equal(old.state, "stopped");
    await assert.rejects(
      successor.execute(caller(1), command("stale-caller")),
      errorCode("ActionOwnershipLost"),
    );
    assert.equal(successor.state, "acquired");
    const receipt = await old.readReceipt(caller(1), {
      domain: "logical",
      key: "step",
    });
    assert.deepEqual(receipt?.result, { recordIds: ["step"], eventIds: [] });
    assert.equal(
      await successor.readReceipt(caller(1, "worker-b"), {
        domain: "logical",
        key: "step",
      }),
      undefined,
    );
    await assert.rejects(
      successor.readReceipt({ ...caller(1), authenticated: false }, {
        domain: "logical",
        key: "step",
      }),
      /not authenticated/,
    );
    assert.equal(
      (await successor.execute(caller(2), command("step"))).status,
      "duplicate",
    );
    assert.deepEqual(await nodeIds(db), ["step"]);
  });
});

test("a known pre-commit whole-group rollback retries commands individually without leaking effects", async () => {
  await fixture(async (db) => {
    let inject = false;
    let fault = false;
    const rolledBackSnapshots: string[][] = [];
    const calls: string[] = [];
    const session: SqlSession = {
      query: db.query,
      async transaction(operation) {
        try {
          return await db.transaction((tx) =>
            operation({
              query(sql, params) {
                if (inject && !fault && sql === "SAVEPOINT owner_command_1") {
                  fault = true;
                  return Promise.reject(
                    new Error("confirmed pre-commit failure"),
                  );
                }
                return tx.query(sql, params);
              },
            })
          );
        } catch (error) {
          rolledBackSnapshots.push(await nodeIds(db));
          throw error;
        }
      },
    };
    const owner = createOwnerCommandBoundary(
      options(session, {
        handlers: {
          async put(intent, ctx) {
            calls.push(ctx.command.key);
            return await put(intent, ctx);
          },
        },
      }),
    );
    await owner.acquire(0);
    inject = true;
    const results = await Promise.all([
      owner.execute(caller(), command("a")),
      owner.execute(caller(), command("b")),
    ]);
    assert.deepEqual(results.map((result) => result.status), [
      "committed",
      "committed",
    ]);
    assert.deepEqual(rolledBackSnapshots, [[]]);
    assert.deepEqual(calls, ["a", "a", "b"]);
    assert.deepEqual(await nodeIds(db), ["a", "b"]);
    assert.equal(owner.state, "acquired");
  });
});

test("outputs and callbacks wait for outer commit; callbacks can reenter the command queue", async () => {
  await fixture(async (db) => {
    const reached = deferred();
    const release = deferred();
    const callbackDone = deferred();
    let gate = false;
    let output = false;
    let callbacks = 0;
    const session: SqlSession = {
      query: db.query,
      transaction(operation) {
        return db.transaction(async (tx) => {
          const result = await operation(tx);
          if (gate) {
            gate = false;
            reached.resolve();
            await release.promise;
          }
          return result;
        });
      },
    };
    const owner = createOwnerCommandBoundary(
      options(session, {
        maxGroup: 1,
        handlers: {
          async put(intent, ctx) {
            const result = await put(intent, ctx);
            if (ctx.command.key === "first") {
              ctx.afterCommit(async () => {
                callbacks++;
                await owner.execute(caller(), command("nested"));
                callbackDone.resolve();
              });
            }
            return result;
          },
        },
      }),
    );
    await owner.acquire(0);
    gate = true;
    const pending = owner.execute(caller(), command("first")).then((result) => {
      output = true;
      return result;
    });
    await reached.promise;
    assert.equal(output, false);
    assert.equal(callbacks, 0);
    release.resolve();
    await pending;
    await callbackDone.promise;
    assert.equal(callbacks, 1);
    assert.deepEqual(await nodeIds(db), ["first", "nested"]);
  });
});

for (const committed of [true, false]) {
  test(`simulated unknown ${committed ? "committed" : "aborted"} mixed group self-stops and receipts decide recovery`, async () => {
    await fixture(async (db) => {
      let inject = false;
      let callbacks = 0;
      const initialPublished = deferred();
      const session: SqlSession = {
        query: db.query,
        async transaction(operation) {
          if (!inject) return await db.transaction(operation);
          inject = false;
          if (committed) {
            await db.transaction(operation);
            throw new Error("simulated COMMIT response lost");
          }
          return await db.transaction(async (tx) => {
            await operation(tx);
            throw new Error("simulated response lost after server abort");
          });
        },
      };
      const handlers: Record<string, OwnerCommandHandler> = {
        async put(intent, ctx) {
          const result = await put(intent, ctx);
          ctx.afterCommit(() => {
            callbacks++;
            if (ctx.command.key === "existing") initialPublished.resolve();
          });
          if (ctx.command.key === "failed") {
            throw new Error("individual failure");
          }
          return result;
        },
      };
      const owner = createOwnerCommandBoundary(options(session, { handlers }));
      await owner.acquire(0);
      await owner.execute(caller(), command("existing"));
      await initialPublished.promise;
      callbacks = 0;
      inject = true;
      const group = await Promise.allSettled([
        owner.execute(caller(), command("existing")),
        owner.execute(caller(), command("existing", { id: "conflicting" })),
        owner.execute(caller(), command("new")),
        owner.execute(caller(), command("failed")),
      ]);
      assert.ok(
        group.every((result) =>
          result.status === "rejected" &&
          errorCode("owner_commit_unknown")(result.reason)
        ),
      );
      assert.equal(owner.state, "stopped");
      assert.equal(callbacks, 0);
      await assert.rejects(
        owner.execute(caller(), command("refused")),
        errorCode("owner_commit_unknown"),
      );
      assert.ok(
        await owner.readReceipt(caller(), {
          domain: "logical",
          key: "existing",
        }),
      );
      assert.equal(
        !!await owner.readReceipt(caller(), { domain: "logical", key: "new" }),
        committed,
      );
      assert.equal(
        await owner.readReceipt(caller(), { domain: "logical", key: "failed" }),
        undefined,
      );
      const successor = createOwnerCommandBoundary(
        options(db, { holderId: "successor", handlers }),
      );
      await successor.acquire(1);
      assert.equal(
        (await successor.execute(caller(2), command("new"))).status,
        committed ? "duplicate" : "committed",
      );
      assert.equal(
        (await db.query<{ writes: number }>(
          "SELECT (data->>'writes')::int AS writes FROM nodes WHERE id='new'",
        )).rows[0].writes,
        1,
      );
    });
  });
}

test("bounded admission counts active work, and explicit stop rolls back active and refuses queued work", async () => {
  await fixture(async (db) => {
    assert.throws(
      () => createOwnerCommandBoundary(options(db, { maxGroup: 33 })),
      /maxGroup/,
    );
    const entered = deferred();
    const release = deferred();
    const owner = createOwnerCommandBoundary(
      options(db, {
        maxQueue: 2,
        maxGroup: 1,
        handlers: {
          async put(intent, ctx) {
            const result = await put(intent, ctx);
            entered.resolve();
            await release.promise;
            return result;
          },
        },
      }),
    );
    await owner.acquire(0);
    const first = owner.execute(caller(), command("first"));
    const second = owner.execute(caller(), command("second"));
    const all = Promise.allSettled([first, second]);
    await entered.promise;
    await assert.rejects(
      owner.execute(caller(), command("overflow")),
      errorCode("owner_admission_refused"),
    );
    owner.stop();
    release.resolve();
    assert.ok((await all).every((result) => result.status === "rejected"));
    assert.deepEqual(await nodeIds(db), []);
    assert.equal(
      (await db.query("SELECT * FROM owner_receipts")).rows.length,
      0,
    );
  });
});

test("identity domains remain separate and caller-provided JSON is snapshotted safely", async () => {
  await fixture(async (db) => {
    const owner = createOwnerCommandBoundary(options(db));
    await owner.acquire(0);
    const intent = { id: "original" };
    const pending = owner.execute(caller(), command("same", intent));
    intent.id = "changed";
    await pending;
    for (const identityDomain of ["incarnation", "occurrence"] as const) {
      await owner.execute(caller(), {
        ...command("same", { id: identityDomain }),
        domain: identityDomain,
      });
    }
    let reads = 0;
    const bad = {
      get id() {
        reads++;
        return "getter";
      },
    };
    await assert.rejects(
      owner.execute(caller(), command("bad", bad)),
      errorCode("owner_command_invalid"),
    );
    assert.equal(reads, 0);
    await assert.rejects(
      owner.execute(
        caller(),
        command("undefined", { id: undefined } as unknown as OwnerJson),
      ),
      errorCode("owner_command_invalid"),
    );
    assert.deepEqual(await nodeIds(db), [
      "incarnation",
      "occurrence",
      "original",
    ]);
  });
});

test("durable outcomes are JSON-only and command SQL capabilities expire", async () => {
  await fixture(async (db) => {
    let leaked: SqlExecutor | undefined;
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: {
        async put(intent, ctx) {
          leaked = ctx.tx;
          Object.assign(ctx.command, { key: "changed" });
          Object.assign(ctx.caller, { workerId: "changed" });
          return await put(intent, ctx);
        },
        async unsafe(intent, ctx) {
          await put(intent, ctx);
          return { secret: undefined } as unknown as OwnerJson;
        },
        async escape(_intent, ctx) {
          await ctx.tx.query("COMMIT");
          return null;
        },
      },
    }));
    await owner.acquire(0);
    await owner.execute(caller(), command("good"));
    await assert.rejects(
      leaked!.query("SELECT 1"),
      errorCode("owner_command_closed"),
    );
    await assert.rejects(
      owner.execute(caller(), command("bad", { id: "bad" }, "unsafe")),
      errorCode("owner_command_invalid"),
    );
    await assert.rejects(
      owner.execute(caller(), command("escape", null, "escape")),
      errorCode("owner_transaction_control_forbidden"),
    );
    assert.deepEqual(await nodeIds(db), ["good"]);
  });
});

test("post-commit publication is ordered and bounded independently of SQL progress", async () => {
  await fixture(async (db) => {
    const firstStarted = deferred();
    const release = deferred();
    const secondPublished = deferred();
    const published: string[] = [];
    const owner = createOwnerCommandBoundary(options(db, {
      maxQueue: 8,
      maxPostCommitGroups: 2,
      maxCallbacksPerCommand: 1,
      handlers: {
        async put(intent, ctx) {
          const result = await put(intent, ctx);
          ctx.afterCommit(async () => {
            if (ctx.command.key === "first") {
              firstStarted.resolve();
              await release.promise;
            }
            published.push(ctx.command.key);
            if (ctx.command.key === "second") secondPublished.resolve();
          });
          if (ctx.command.key === "too-many") ctx.afterCommit(() => {});
          return result;
        },
      },
    }));
    await owner.acquire(0);
    await owner.execute(caller(), command("first"));
    await firstStarted.promise;
    await owner.execute(caller(), command("second"));
    assert.deepEqual(await nodeIds(db), ["first", "second"]);
    assert.deepEqual(published, []);
    await assert.rejects(
      owner.execute(caller(), command("overflow")),
      errorCode("owner_admission_refused"),
    );
    release.resolve();
    await secondPublished.promise;
    await Promise.resolve();
    assert.deepEqual(published, ["first", "second"]);
    await assert.rejects(
      owner.execute(caller(), command("too-many")),
      errorCode("owner_admission_refused"),
    );
    assert.deepEqual(await nodeIds(db), ["first", "second"]);
  });
});

test("authorization and handler copies cannot poison persisted receipt identity or intent", async () => {
  await fixture(async (db) => {
    const owner = createOwnerCommandBoundary(options(db, {
      authorize(_tx, who, request) {
        Object.assign(who, { workerId: "poisoned" });
        Object.assign(request, { key: "poisoned", kind: "poisoned" });
        Object.assign(request.intent as object, { id: "poisoned" });
      },
      authenticateReceipt(_tx, who) {
        Object.assign(who, { workerId: "poisoned" });
      },
      handlers: {
        async put(intent, ctx) {
          Object.assign(ctx.caller, { workerId: "poisoned" });
          Object.assign(ctx.command, { key: "poisoned" });
          return await put(intent, ctx);
        },
      },
    }));
    await owner.acquire(0);
    await owner.execute(caller(), command("original"));
    const receipt = await owner.readReceipt(caller(), {
      domain: "logical",
      key: "original",
    });
    assert.deepEqual(receipt?.intent, { id: "original" });
    assert.deepEqual(receipt?.result, {
      recordIds: ["original"],
      eventIds: [],
    });
    assert.equal(
      (await owner.execute(caller(), command("original"))).status,
      "duplicate",
    );
  });
});

test("queued and active pre-commit cancellation discard effects without erasing durable receipts", async () => {
  await fixture(async (db) => {
    const entered = deferred();
    const release = deferred();
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const owner = createOwnerCommandBoundary(
      options(db, {
        maxGroup: 1,
        handlers: {
          async put(intent, ctx) {
            const result = await put(intent, ctx);
            if (ctx.command.key === "active") {
              entered.resolve();
              await release.promise;
            }
            return result;
          },
        },
      }),
    );
    await owner.acquire(0);
    const active = owner.execute(caller(), command("active"), {
      signal: activeAbort.signal,
    });
    const queued = owner.execute(caller(), command("queued"), {
      signal: queuedAbort.signal,
    });
    const outcomes = Promise.allSettled([active, queued]);
    await entered.promise;
    queuedAbort.abort();
    activeAbort.abort();
    release.resolve();
    assert.ok((await outcomes).every((result) => result.status === "rejected"));
    assert.deepEqual(await nodeIds(db), []);
    const durableAbort = new AbortController();
    await owner.execute(caller(), command("durable"), {
      signal: durableAbort.signal,
    });
    durableAbort.abort();
    assert.ok(
      await owner.readReceipt(caller(), { domain: "logical", key: "durable" }),
    );
    assert.deepEqual(await nodeIds(db), ["durable"]);
  });
});

test("handler signal mutation cannot mask the private latched cancellation", async () => {
  await fixture(async (db) => {
    const source = new AbortController();
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: {
        async put(intent, ctx) {
          const result = await put(intent, ctx);
          assert.notEqual(ctx.signal, source.signal);
          Object.defineProperty(ctx.signal, "aborted", { value: false });
          Object.defineProperty(ctx.signal, "reason", { value: undefined });
          Object.defineProperty(ctx.signal, "throwIfAborted", { value() {} });
          source.abort(new Error("source cancelled"));
          return result;
        },
      },
    }));
    await owner.acquire(0);
    await assert.rejects(
      owner.execute(caller(), command("aborted"), { signal: source.signal }),
      /source cancelled/,
    );
    assert.deepEqual(await nodeIds(db), []);
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts")).rows.length,
      0,
    );
  });
});

test("nested host authority bindings are isolated and nondata bindings are rejected without capacity leaks", async () => {
  await fixture(async (db) => {
    const identity = {
      ...caller(),
      binding: { roles: ["writer"], principal: { id: "person" } },
    };
    const owner = createOwnerCommandBoundary(
      options(db, {
        maxQueue: 1,
        authorize(_tx, who) {
          (who.binding as typeof identity.binding).roles.push("poisoned");
        },
        authenticateReceipt(_tx, who) {
          (who.binding as typeof identity.binding).principal.id = "poisoned";
        },
        handlers: {
          async put(intent, ctx) {
            assert.deepEqual(
              (ctx.caller.binding as typeof identity.binding).roles,
              ["writer"],
            );
            (ctx.caller.binding as typeof identity.binding).principal.id =
              "handler-poisoned";
            return await put(intent, ctx);
          },
        },
      }),
    );
    await owner.acquire(0);
    await assert.rejects(
      owner.execute({ ...identity, callback() {} }, command("invalid")),
      errorCode("owner_command_invalid"),
    );
    await owner.execute(identity, command("valid"));
    assert.ok(
      await owner.readReceipt(identity, { domain: "logical", key: "valid" }),
    );
    assert.deepEqual(identity.binding, {
      roles: ["writer"],
      principal: { id: "person" },
    });
    await assert.rejects(
      owner.readReceipt({ ...identity, opaque: new Date() }, {
        domain: "logical",
        key: "valid",
      }),
      errorCode("owner_command_invalid"),
    );
  });
});

test("persistence-indeterminate command errors self-stop instead of being treated as ordinary rejection", async () => {
  await fixture(async (db) => {
    const ambiguous = Object.assign(
      new Error("in-flight persistence outcome unknown"),
      { code: "persistence_indeterminate", indeterminate: true },
    );
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: {
        async put(intent, ctx) {
          await put(intent, ctx);
          throw ambiguous;
        },
      },
    }));
    await owner.acquire(0);
    await assert.rejects(
      owner.execute(caller(), command("uncertain")),
      (error) => error === ambiguous,
    );
    assert.equal(owner.state, "stopped");
    assert.deepEqual(await nodeIds(db), []);
  });
});

test("receipt authentication is read-only and per-command timestamps can cross authority expiry", async () => {
  await fixture(async (db) => {
    let tick = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      now: () => `2026-10-16T23:00:0${tick++}.000Z`,
      authorize(_tx, _who, _request, time) {
        if (time >= "2026-10-16T23:00:01.000Z") {
          throw new Error("lease expired");
        }
      },
      async authenticateReceipt(tx) {
        await tx.query("UPDATE public.nodes SET name='forbidden'");
      },
    }));
    await owner.acquire(0);
    const results = await Promise.allSettled([
      owner.execute(caller(), command("before")),
      owner.execute(caller(), command("after")),
    ]);
    assert.deepEqual(results.map((result) => result.status), [
      "fulfilled",
      "rejected",
    ]);
    await assert.rejects(
      owner.readReceipt(caller(), { domain: "logical", key: "before" }),
      /read-only/,
    );
    assert.equal(
      (await db.query<{ name: string }>(
        "SELECT name FROM nodes WHERE id='before'",
      )).rows[0].name,
      "before",
    );
    assert.deepEqual(await nodeIds(db), ["before"]);
  });
});

test("current-authorized projections never persist inputs or output in receipts", async () => {
  await fixture(async (db) => {
    let status = "active";
    let reads = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      authorize(_tx, who) {
        if (who.authenticated !== true || status !== "active") {
          throw new Error("projection authority expired");
        }
      },
      projections: {
        input: async (input, context) => {
          assert.deepEqual(Object.keys(context).sort(), [
            "caller",
            "commandTime",
            "signal",
            "tx",
          ]);
          reads++;
          const count = await context.tx.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM public.nodes",
          );
          return { input, visible: "authorized", count: count.rows[0].count };
        },
      },
    }));
    await owner.acquire(0);
    assert.deepEqual(await owner.project(caller(), "input", { ref: "job" }), {
      input: { ref: "job" },
      visible: "authorized",
      count: 0,
    });
    assert.equal(
      (await db.query("SELECT * FROM public.owner_receipts")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM public.events")).rows.length,
      0,
    );
    assert.deepEqual(await nodeIds(db), []);
    for (status of ["revoked", "expired", "settled"]) {
      await assert.rejects(
        owner.project(caller(), "input", { ref: "job" }),
        /authority expired/,
      );
    }
    assert.equal(reads, 1);
    status = "active";
    await assert.rejects(
      owner.project(caller(0), "input", null),
      errorCode("ActionOwnershipLost"),
    );
    await assert.rejects(
      owner.execute(caller(), command("wrong", null, "input")),
      errorCode("owner_command_invalid"),
    );
  });
});

test("projection output waits for outer commit and disappears on indeterminate completion", async () => {
  await fixture(async (db) => {
    const entered = deferred();
    const release = deferred();
    let gate = false;
    let lose = false;
    const session: SqlSession = {
      query: (sql, params) => db.query(sql, params),
      async transaction(run) {
        const result = await db.transaction(async (tx) => {
          const result = await run(tx);
          if (gate) {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
        if (lose) {
          throw Object.assign(new Error("lost completion"), {
            indeterminate: true,
          });
        }
        return result;
      },
    };
    const owner = createOwnerCommandBoundary(
      options(session, {
        projections: {
          input: () => ({ privateValue: "only-current-authority" }),
        },
      }),
    );
    await owner.acquire(0);
    gate = true;
    let leaked = false;
    const result = owner.project(caller(), "input", null).then((value) => {
      leaked = true;
      return value;
    });
    await entered.promise;
    assert.equal(leaked, false);
    lose = true;
    release.resolve();
    await assert.rejects(result, /lost completion/);
    assert.equal(leaked, false);
    assert.equal(owner.state, "stopped");
    assert.equal(
      (await db.query("SELECT * FROM public.owner_receipts")).rows.length,
      0,
    );
  });
});

test("cancelled projections revoke their context without leaking results", async () => {
  await fixture(async (db) => {
    const entered = deferred();
    const release = deferred();
    let captured: SqlExecutor | undefined;
    const owner = createOwnerCommandBoundary(options(db, {
      projections: {
        input: async (_input, context) => {
          captured = context.tx;
          entered.resolve();
          await release.promise;
          return { value: "never delivered" };
        },
      },
    }));
    await owner.acquire(0);
    const abort = new AbortController();
    const result = owner.project(caller(), "input", null, {
      signal: abort.signal,
    });
    const rejection = assert.rejects(result, /cancel projection/);
    await entered.promise;
    abort.abort(new Error("cancel projection"));
    release.resolve();
    await rejection;
    await assert.rejects(
      captured!.query("SELECT 1"),
      errorCode("owner_command_closed"),
    );
    assert.equal(
      (await db.query("SELECT * FROM public.owner_receipts")).rows.length,
      0,
    );
  });
});

for (const retire of ["abort", "stop"] as const) {
  test(`projection ${retire} during COMMIT suppresses ephemeral output`, async () => {
    await fixture(async (db) => {
      const entered = deferred();
      const release = deferred();
      let gated = false;
      const session: SqlSession = {
        query: (sql, params) => db.query(sql, params),
        transaction: (run) =>
          db.transaction(async (tx) => {
            const value = await run(tx);
            if (gated) {
              entered.resolve();
              await release.promise;
            }
            return value;
          }),
      };
      const owner = createOwnerCommandBoundary(
        options(session, {
          projections: { input: () => ({ privateValue: "revoked input" }) },
        }),
      );
      await owner.acquire(0);
      gated = true;
      const abort = new AbortController();
      const result = owner.project(caller(), "input", null, {
        signal: abort.signal,
      });
      await entered.promise;
      if (retire === "abort") abort.abort(new Error("assignment revoked"));
      else owner.stop(new Error("assignment revoked"));
      release.resolve();
      await assert.rejects(result, /assignment revoked|stopped/);
      assert.equal(
        (await db.query("SELECT * FROM public.owner_receipts")).rows.length,
        0,
      );
    });
  });
}
