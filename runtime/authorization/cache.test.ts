import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  authorizationDependencyKeys,
  authorizationRowKeys,
  authorizationTableKey,
  hintAuthorizationChanges,
  hintAuthorizationRows,
  memoAuthorizationRead,
  memoizeSnapshotReads,
  observeAuthorizationWrites,
  OwnerAuthorizationCache,
  readAuthorizationRecord,
} from "./cache.ts";
import { runSqlTransaction, type SqlExecutor } from "../events/session.ts";

Deno.test("authorization write observer parses DO UPDATE SET as an upsert, not a SET table", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  await runSqlTransaction(
    { transaction: (run) => run(raw) },
    async (managed) => {
      const tx = observeAuthorizationWrites(managed, owner, "public", 1);
      const fake = owner.stamp([authorizationTableKey("public", "SET")]);
      const target = owner.stamp([
        authorizationTableKey("public", "copilotz_operations"),
      ]);
      await tx.query(
        `INSERT INTO "public"."copilotz_operations"(operation_id) VALUES($1) ON CONFLICT(operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id`,
        ["A"],
      );
      assertEquals(owner.valid(fake), true);
      assertEquals(owner.valid(target), false);
      await tx.query(`UPDATE "SET" SET value=1`);
      assertEquals(owner.valid(fake), false);
    },
  );
});

Deno.test("classified owner row writes preserve unrelated rows; unknown writes fence the table", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  await runSqlTransaction(
    { transaction: (run) => run(raw) },
    async (managed) => {
      const tx = observeAuthorizationWrites(managed, owner, "public", 1);
      const a = owner.stamp(
        authorizationRowKeys("public", "event_deliveries", "A"),
      );
      const b = owner.stamp(
        authorizationRowKeys("public", "event_deliveries", "B"),
      );
      hintAuthorizationRows(tx, "public", "event_deliveries", ["A"]);
      await tx.query(
        `UPDATE public.event_deliveries SET status='succeeded' WHERE id='A'`,
      );
      assertEquals(owner.valid(a), false);
      assertEquals(owner.valid(b), true);
      await tx.query(
        `UPDATE PUBLIC.EVENT_DELIVERIES SET status='cancelled' WHERE id='B'`,
      );
      assertEquals(owner.valid(b), false);
    },
  );
});

Deno.test("returned write sets fence pending reads and invalidate only returned rows, failures fall back", async () => {
  const owner = new OwnerAuthorizationCache();
  let finish: (() => void) | undefined;
  const raw: SqlExecutor = {
    async query<T>() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { rows: [{ id: "A" }] as T[], rowCount: 1 };
    },
  };
  await runSqlTransaction(
    { transaction: (run) => run(raw) },
    async (managed) => {
      const tx = observeAuthorizationWrites(managed, owner, "public", 1);
      const a = owner.stamp(
        authorizationRowKeys("public", "event_deliveries", "A"),
      );
      const b = owner.stamp(
        authorizationRowKeys("public", "event_deliveries", "B"),
      );
      hintAuthorizationRows(
        tx,
        "public",
        "event_deliveries",
        (rows) => rows.map((row) => String(row.id)),
      );
      const pending = tx.query(
        `UPDATE public.event_deliveries SET status='cancelled' WHERE settlement_scope_id='scope' RETURNING *`,
      );
      assertEquals(owner.valid(b), false);
      finish!();
      await pending;
      assertEquals(owner.valid(a), false);
      assertEquals(owner.valid(b), true);
      raw.query = () => Promise.reject(new Error("rollback"));
      const failing = tx;
      hintAuthorizationRows(
        failing,
        "public",
        "event_deliveries",
        (rows) => rows.map((row) => String(row.id)),
      );
      await failing.query(`DELETE FROM public.event_deliveries RETURNING id`)
        .catch(() => {});
      assertEquals(owner.valid(b), false);
    },
  );
});

Deno.test("complete manifest write sets invalidate records and sets without fencing unrelated records", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  const record = (collection: string, id?: string) => ({
    owner: "schema",
    namespace: "space",
    collection,
    ...(id ? { id } : {}),
  });
  const stamp = (collection: string, id?: string) =>
    owner.stamp(
      authorizationDependencyKeys("public", [record(collection, id)]),
    );
  await runSqlTransaction(
    { transaction: (run) => run(raw) },
    async (managed) => {
      const tx = observeAuthorizationWrites(managed, owner, "public", 1);
      const message = stamp("message", "A");
      const asset = stamp("asset", "body-A");
      const messages = stamp("message");
      const assets = stamp("asset");
      const other = stamp("message", "B");
      const otherAsset = stamp("asset", "body-B");
      hintAuthorizationChanges(tx, [
        record("message", "A"),
        record("asset", "body-A"),
      ]);
      await tx.query(
        `WITH projection_manifest_inserted AS (
          INSERT INTO public.nodes(id,type) VALUES('body-A','asset')
        ) INSERT INTO public.nodes(id,type) VALUES('A','message')`,
      );
      for (const changed of [message, asset, messages, assets]) {
        assertEquals(owner.valid(changed), false);
      }
      for (const unchanged of [other, otherAsset]) {
        assertEquals(owner.valid(unchanged), true);
      }
      // Hints apply to one complete statement only; opaque writes stay coarse.
      await tx.query("UPDATE public.nodes SET data='{}' WHERE id='B'");
      assertEquals(owner.valid(other), false);
      assertEquals(owner.valid(otherAsset), false);
    },
  );
});

Deno.test("internal immutable record snapshots reuse captures without sharing mutable caller data", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  let loads = 0;
  const dependency = {
    owner: "schema",
    namespace: "space",
    collection: "message",
    id: "one",
  };
  await runSqlTransaction(
    { transaction: (run) => run(raw) },
    async (managed) => {
      const tx = observeAuthorizationWrites(managed, owner, "public", 1);
      const load = () => {
        loads++;
        return Promise.resolve({ nested: { value: loads } });
      };
      const snapshot = () =>
        readAuthorizationRecord(tx, "public", dependency, load, {
          immutableJson: true,
        });
      const first = await snapshot();
      assert(first === await snapshot());
      assertThrows(() => {
        first.nested.value = 99;
      });
      const mutable = await readAuthorizationRecord(
        tx,
        "public",
        dependency,
        load,
      );
      mutable.nested.value = 99;
      assertEquals((await snapshot()).nested.value, 1);
      hintAuthorizationChanges(tx, [dependency]);
      await tx.query("UPDATE public.nodes SET data='{}' WHERE id='one'");
      assertEquals((await snapshot()).nested.value, 2);
    },
  );
});

Deno.test("committed policy facts serve later commands until a write touches them", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  let loads = 0;
  const dependency = {
    owner: "schema",
    namespace: "space",
    collection: "thread",
    id: "one",
  };
  const keys = authorizationDependencyKeys("public", [dependency]);
  const command = <T>(run: (tx: SqlExecutor) => Promise<T>) =>
    runSqlTransaction(
      { transaction: (operation) => operation(raw) },
      (managed) => run(observeAuthorizationWrites(managed, owner, "public", 1)),
    );
  const fact = (tx: SqlExecutor) =>
    memoAuthorizationRead(tx, "thread:one", keys, () => {
      loads++;
      return Promise.resolve({ members: [loads] });
    });
  const first = await command(fact);
  (first as { members: number[] }).members.push(99);
  assertEquals(await command(fact), { members: [1] });
  assertEquals(loads, 1);
  // A rolled-back command never publishes what it read.
  owner.invalidate(keys);
  await runSqlTransaction(
    { transaction: (operation) => operation(raw) },
    async (managed) => {
      await fact(observeAuthorizationWrites(managed, owner, "public", 1));
      throw new Error("rollback");
    },
  ).catch(() => undefined);
  assertEquals(await command(fact), { members: [3] });
  await command(async (tx) => {
    hintAuthorizationChanges(tx, [dependency]);
    await tx.query("UPDATE public.nodes SET data='{}' WHERE id='one'");
  });
  assertEquals(await command(fact), { members: [4] });
  // A read whose write lands before it returns stays local to its command.
  owner.invalidate(keys);
  await command(async (tx) => {
    const read = fact(tx);
    hintAuthorizationChanges(tx, [dependency]);
    await tx.query("UPDATE public.nodes SET data='{}' WHERE id='one'");
    await read;
  });
  assertEquals(await command(fact), { members: [6] });
  assertEquals(loads, 6);
});

Deno.test("a read snapshot shares facts privately and never publishes them to the owner", async () => {
  const owner = new OwnerAuthorizationCache();
  const raw: SqlExecutor = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  let loads = 0;
  const keys = [authorizationTableKey("public", "authorization_sessions")];
  const read = (tx: SqlExecutor) =>
    memoAuthorizationRead(tx, "session", keys, () => {
      loads++;
      return Promise.resolve({ loads });
    });
  const snapshot = () =>
    runSqlTransaction(
      { transaction: (operation) => operation(raw) },
      async (managed) => {
        const tx = memoizeSnapshotReads(managed);
        return [await read(tx), await read(tx)];
      },
    );
  assertEquals(await snapshot(), [{ loads: 1 }, { loads: 1 }]);
  assertEquals(await snapshot(), [{ loads: 2 }, { loads: 2 }]);
  await runSqlTransaction(
    { transaction: (operation) => operation(raw) },
    async (managed) => {
      assertEquals(
        await read(observeAuthorizationWrites(managed, owner, "public", 1)),
        { loads: 3 },
      );
    },
  );
});
