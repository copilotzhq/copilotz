import { assertEquals } from "@std/assert";
import {
  authorizationRowKeys,
  authorizationTableKey,
  hintAuthorizationRows,
  observeAuthorizationWrites,
  OwnerAuthorizationCache,
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
