import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  afterSqlCommit,
  afterSqlSettlement,
  bindSqlTransactionAlias,
  createSqlSession,
  runSqlTransaction,
  sqlCommitGate,
  type SqlExecutor,
} from "./session.ts";

Deno.test("SQL output gate opens only after the adapter confirms outer commit", async () => {
  const order: string[] = [];
  let gate!: () => void;
  let retained!: SqlExecutor;
  const value = await runSqlTransaction({
    async transaction(operation) {
      const result = await operation({
        query: () => Promise.resolve({ rows: [] }),
      });
      assertThrows(gate, Error, "has not confirmed commit");
      order.push("commit");
      return result;
    },
  }, (transaction) => {
    retained = transaction;
    gate = sqlCommitGate(transaction);
    afterSqlCommit(transaction, () => order.push("publish"));
    assertThrows(gate, Error, "has not confirmed commit");
    return Promise.resolve("result");
  });
  assertEquals(value, "result");
  assertEquals(order, ["commit", "publish"]);
  gate();
  await assertRejects(() => retained.query("SELECT 1"), Error, "closed");
});

for (const outcome of ["rollback", "unknown commit"] as const) {
  Deno.test(`SQL output gate stays closed after ${outcome}`, async () => {
    let gate!: () => void;
    let publications = 0;
    let settled = 0;
    await assertRejects(() =>
      runSqlTransaction({
        async transaction(operation) {
          await operation({ query: () => Promise.resolve({ rows: [] }) });
          throw new Error("commit acknowledgement lost");
        },
      }, (transaction) => {
        const alias: SqlExecutor = {
          query: (sql, params) => transaction.query(sql, params),
        };
        bindSqlTransactionAlias(alias, transaction);
        gate = sqlCommitGate(alias);
        afterSqlCommit(alias, () => publications++);
        afterSqlSettlement(alias, () => settled++);
        if (outcome === "rollback") throw new Error("rollback");
        return Promise.resolve();
      })
    );
    assertEquals(publications, 0);
    assertEquals(settled, 1);
    assertThrows(gate, Error, "has not confirmed commit");
  });
}

Deno.test("SQL session adapters preserve the outer commit gate when composed", async () => {
  let gate!: () => void;
  let published = false;
  const session = createSqlSession(createSqlSession({
    query: () => Promise.resolve({ rows: [] }),
    async transaction(operation) {
      const result = await operation({
        query: () => Promise.resolve({ rows: [] }),
      });
      assertEquals(published, false);
      assertThrows(gate, Error, "has not confirmed commit");
      return result;
    },
  }));
  await session.transaction((transaction) => {
    gate = sqlCommitGate(transaction);
    afterSqlCommit(transaction, () => published = true);
    return Promise.resolve();
  });
  gate();
  assertEquals(published, true);
});
