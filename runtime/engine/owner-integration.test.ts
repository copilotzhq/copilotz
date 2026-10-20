import { assert, assertEquals } from "@std/assert";
import { createCopilotz, defineAction } from "../../index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { SqlSession } from "../events/session.ts";
import { createSchemaCommandRunner, openDatabaseOwner } from "./commands.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";

Deno.test("long Actions overlap while their storage commands serialize and fence first", async () => {
  const db = await createTestDatabase();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let actions = 0;
  let activeSql = 0;
  let peakSql = 0;
  const transactions: string[][] = [];
  const session: SqlSession = {
    query: db.query,
    transaction: (operation) => {
      const statements: string[] = [];
      transactions.push(statements);
      activeSql++;
      peakSql = Math.max(peakSql, activeSql);
      return db.transaction((transaction) =>
        operation({
          query(sql, parameters) {
            statements.push(sql);
            return transaction.query(sql, parameters);
          },
        })
      ).finally(() => {
        activeSql--;
      });
    },
  };
  const app = await createCopilotz({
    database: { ...session, close: db.close },
    databaseSchema: "owner_parallel_actions",
    namespace: "space",
    actions: {
      slow: defineAction({
        id: "owner.slow",
        async execute(input: { id: string }) {
          if (++actions === 2) entered.resolve();
          await release.promise;
          return input.id;
        },
      }),
    },
  });
  transactions.length = 0;
  peakSql = 0;
  const timeout = setTimeout(
    () => entered.reject(new Error("Action execution was serialized")),
    5_000,
  );
  try {
    const first = app.actions.slow({ id: "first" }, {
      idempotencyKey: "first",
    });
    const second = app.actions.slow({ id: "second" }, {
      idempotencyKey: "second",
    });
    await entered.promise;
    assertEquals(actions, 2);
    assertEquals(
      activeSql,
      0,
      "provider waits do not hold storage transactions",
    );
    release.resolve();
    assertEquals(await Promise.all([first, second]), ["first", "second"]);
    assertEquals(peakSql, 1);
    assert(
      transactions.length >= 2,
      "admission and completion commit around the provider wait",
    );
    for (const statements of transactions) {
      assert(
        statements[0].includes("owner_epochs") &&
          statements[0].includes("SET holder=holder"),
        "every command begins with the locking epoch fence",
      );
    }
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await app.close();
    await db.close();
  }
});

const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
Deno.test({
  name: "Postgres commands in different schemas run concurrently",
  ignore: !postgres,
  async fn() {
    const db = await createTestDatabase({ url: postgres!, pgPoolMax: 4 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const firstSchema = `owner_first_${suffix}`;
    const secondSchema = `owner_second_${suffix}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await provisionCopilotzSchema(db, firstSchema);
      await provisionCopilotzSchema(db, secondSchema);
      const firstOwner = await openDatabaseOwner(db, firstSchema);
      const secondOwner = await openDatabaseOwner(db, secondSchema);
      first = createSchemaCommandRunner(db, firstSchema)(
        "test.hold",
        {},
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      assert(firstOwner.holderId !== secondOwner.holderId);
      const second = createSchemaCommandRunner(db, secondSchema)(
        "test.second",
        {},
        async (_input, { transaction }) => {
          await transaction.query("SELECT 1");
          return "second";
        },
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Independent schema command was blocked")),
          5_000,
        );
      });
      assertEquals(await Promise.race([second, timeout]), "second");
      release.resolve();
      await first;
      firstOwner.stop();
      secondOwner.stop();
    } finally {
      clearTimeout(timer);
      release.resolve();
      await first?.catch(() => undefined);
      await db.query(
        `DROP SCHEMA IF EXISTS "${firstSchema}", "${secondSchema}" CASCADE`,
      );
      await db.close();
    }
  },
});
