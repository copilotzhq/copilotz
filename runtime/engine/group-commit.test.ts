import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { bounded } from "../testing/effect-commit-proxy.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import {
  afterSqlCommit,
  sqlCommitGate,
  type SqlExecutor,
  type SqlSession,
} from "../events/session.ts";
import { createOwnerCommands, createSchemaCommandRunner } from "./commands.ts";

const request = (id: string, fail = false) => ({
  input: { id, fail },
  receipt: {
    identity: { domain: "logical" as const, key: id },
    intent: { id, fail },
  },
});

Deno.test("group isolates success, SQL failure and conflicting replay; times, gates and callbacks belong to each command", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "mixed_group";
  const tables = createCoreTableNames(schema);
  const beforeCommit = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false, clock = 0, transactions = 0;
  const queries: string[] = [], times: string[] = [], published: string[] = [];
  const gates: Array<() => void> = [];
  const scopes: SqlExecutor[] = [];
  const session: SqlSession = {
    ...db,
    transaction: (run) => {
      transactions++;
      return db.transaction(async (tx) => {
        const result = await run({
          query(sql, params) {
            queries.push(sql);
            return tx.query(sql, params);
          },
        });
        if (hold) {
          beforeCommit.resolve();
          await release.promise;
        }
        return result;
      });
    },
  };
  const owner = createOwnerCommands({
    session,
    schema,
    now: () => new Date(++clock * 1000),
    handlers: {
      write: {
        authorize() {},
        async execute(input: { id: string; fail: boolean }, context) {
          times.push(context.commandTime);
          scopes.push(context.transaction);
          gates.push(sqlCommitGate(context.transaction));
          await context.transaction.query(
            `INSERT INTO ${tables.nodes}(id,namespace,type,name) VALUES($1,'space','item',$1)`,
            [input.id],
          );
          afterSqlCommit(
            context.transaction,
            () => published.push(`cache:${input.id}`),
          );
          context.afterCommit(() => {
            published.push(input.id);
          });
          if (input.fail) {
            await context.transaction.query("SELECT 1/0");
          }
          return input.id;
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    await owner.execute("write", caller, request("seed"));
    await Promise.resolve();
    queries.length = 0;
    published.length = 0;
    times.length = 0;
    gates.length = 0;
    scopes.length = 0;
    transactions = 0;
    clock = 0;
    hold = true;
    let settled = false;
    const results = Promise.allSettled([
      owner.execute("write", caller, request("one")),
      owner.execute("write", caller, request("failed", true)),
      owner.execute("write", caller, {
        ...request("seed"),
        receipt: { ...request("seed").receipt, intent: { changed: true } },
      }),
      owner.execute("write", caller, request("seed")),
      owner.execute("write", caller, request("two")),
    ]).then((value) => {
      settled = true;
      return value;
    });
    await bounded(beforeCommit.promise, "mixed group COMMIT");
    assertEquals(transactions, 1);
    assertEquals(settled, false);
    assertEquals(published, []);
    for (const gate of gates) {
      let refused = false;
      try {
        gate();
      } catch {
        refused = true;
      }
      assert(refused);
    }
    for (const scope of scopes) {
      await assertRejects(() => scope.query("SELECT 1"), Error, "closed");
    }
    release.resolve();
    assertEquals((await results).map((r) => r.status), [
      "fulfilled",
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    assertEquals(times, [
      new Date(1000).toISOString(),
      new Date(2000).toISOString(),
      new Date(5000).toISOString(),
    ]);
    assertEquals(published, ["cache:one", "cache:two", "one", "two"]);
    gates[0]();
    gates[2]();
    assertEquals(
      queries.filter((sql) => sql.includes("SET holder=holder")).length,
      1,
    );
    assert(queries[0].includes("SET holder=holder"));
    assertEquals(
      queries.filter((sql) => sql === "SAVEPOINT owner_command").length,
      5,
    );
    assertEquals(
      (await db.query(`SELECT id FROM ${tables.nodes} ORDER BY id`)).rows,
      [{ id: "one" }, { id: "seed" }, { id: "two" }],
    );
    assertEquals(
      (await db.query(`SELECT key FROM ${tables.owner_receipts} ORDER BY key`))
        .rows,
      [{ key: "one" }, { key: "seed" }, { key: "two" }],
    );
  } finally {
    release.resolve();
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("outer rollback discards all staged effects and retries commands individually in order", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "rollback_group";
  const tables = createCoreTableNames(schema);
  let releases = 0, armed = false;
  const statements: string[][] = [],
    executions: string[] = [],
    published: string[] = [];
  const owner = createOwnerCommands({
    schema,
    session: {
      ...db,
      transaction: (run) =>
        db.transaction((tx) => {
          const queries: string[] = [];
          statements.push(queries);
          return run({
            query(sql, params) {
              queries.push(sql);
              if (
                armed && sql.startsWith("RELEASE SAVEPOINT") && ++releases === 2
              ) {
                armed = false;
                throw new Error("outer transaction failed before commit");
              }
              return tx.query(sql, params);
            },
          });
        }),
    },
    handlers: {
      write: {
        authorize() {},
        async execute(input: { id: string; fail: boolean }, context) {
          executions.push(input.id);
          await context.transaction.query(
            `INSERT INTO ${tables.nodes}(id,namespace,type,name) VALUES($1,'space','item',$1)`,
            [input.id],
          );
          context.afterCommit(() => {
            published.push(input.id);
          });
          if (input.fail) throw new Error("refused");
          return input.id;
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    statements.length = 0;
    armed = true;
    const results = await Promise.allSettled(
      ["one", "failed", "two"].map((id) =>
        owner.execute("write", caller, request(id, id === "failed"))
      ),
    );
    assertEquals(results.map((r) => r.status), [
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    assertEquals(executions, ["one", "failed", "one", "failed", "two"]);
    assertEquals(published, ["one", "two"]);
    assertEquals(statements.length, 4);
    assert(statements[0].includes("ROLLBACK AND CHAIN"));
    assert(
      statements.slice(1).every((sql) =>
        !sql.some((s) => s.includes("SAVEPOINT"))
      ),
    );
    assert(statements[2].includes("ROLLBACK AND CHAIN"));
    assertEquals(owner.state, "acquired");
    assertEquals(
      (await db.query(`SELECT id FROM ${tables.nodes} ORDER BY id`)).rows,
      [{ id: "one" }, { id: "two" }],
    );
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("unconfirmed singleton rollback stops authority even when adapter hides its cleanup failure", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "rollback_unknown";
  const owner = createOwnerCommands({
    schema,
    session: {
      ...db,
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query(sql, params) {
              if (sql === "ROLLBACK AND CHAIN") {
                throw new Error("rollback acknowledgement lost");
              }
              return tx.query(sql, params);
            },
          })
        ),
    },
    handlers: {
      write: {
        authorize() {},
        execute() {
          throw new Error("validation refused");
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    await assertRejects(
      () => owner.execute("write", caller, { input: {} }),
      Error,
      "rollback acknowledgement lost",
    );
    assertEquals(owner.state, "stopped");
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("count and UTF-8 byte limits split only already queued commands; oversized inputs run alone", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "bounded_group";
  let transactions = 0;
  const groups: string[][] = [];
  const input = { input: "é" };
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  const owner = createOwnerCommands({
    schema,
    maxGroupCount: 3,
    maxGroupBytes: bytes * 2,
    session: {
      ...db,
      transaction: (run) => {
        transactions++;
        groups.push([]);
        return db.transaction(run);
      },
    },
    handlers: {
      write: {
        authorize() {},
        execute(input: string) {
          groups.at(-1)!.push(input);
          return input;
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    transactions = 0;
    groups.length = 0;
    await Promise.all(
      ["é", "é", "x".repeat(100), "é", "é", "é"].map((input) =>
        owner.execute("write", caller, { input })
      ),
    );
    assertEquals(transactions, 4);
    assertEquals(groups.map((g) => g.length), [2, 1, 2, 1]);
    await bounded(
      owner.execute("write", caller, { input: "alone" }),
      "singleton without wait window",
    );
    assertEquals(transactions, 5);
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("nested registered commands and transaction-bound helpers join without queue deadlock", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "nested_group";
  let transactions = 0;
  const owner = createOwnerCommands({
    session: {
      ...db,
      transaction: (run) => {
        transactions++;
        return db.transaction(run);
      },
    },
    schema,
    handlers: {},
  });
  const publications: string[] = [];
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    const nested = owner.register("nested", {
      authorize(_input, ctx) {
        assertEquals(ctx.caller.principal, "nested-principal");
      },
      execute(_input: string, ctx) {
        ctx.afterCommit(() => {
          publications.push("nested");
        });
        return "nested";
      },
    });
    const outer = owner.register("outer", {
      authorize() {},
      async execute(_input: string, ctx) {
        ctx.afterCommit(() => {
          publications.push("outer");
        });
        assertEquals(
          await nested({ ...caller, principal: "nested-principal" }, {
            input: "nested",
          }),
          "nested",
        );
        const joined = createSchemaCommandRunner(ctx.transaction, schema);
        await joined("helper", {}, (_input, inner) => {
          assertEquals(inner.transaction, ctx.transaction);
          inner.afterCommit(() => {
            publications.push("helper");
          });
        });
        assertEquals(publications, []);
        return "done";
      },
    });
    transactions = 0;
    assertEquals(
      await bounded(
        Promise.all([
          outer(caller, { input: "one" }),
          outer(caller, { input: "two" }),
        ]),
        "nested group",
      ),
      ["done", "done"],
    );
    assertEquals(transactions, 1);
    assertEquals(publications, [
      "outer",
      "nested",
      "helper",
      "outer",
      "nested",
      "helper",
    ]);
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("group count, active admission and staged publication capacities stay bounded", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "group_capacity";
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const groups: string[][] = [], published: string[] = [];
  const owner = createOwnerCommands({
    schema,
    maxQueue: 3,
    maxGroupCount: 2,
    maxPublications: 1,
    session: {
      ...db,
      transaction: (run) => {
        groups.push([]);
        return db.transaction(run);
      },
    },
    handlers: {
      write: {
        authorize() {},
        async execute(input: string, ctx) {
          groups.at(-1)!.push(input);
          if (input === "one") {
            entered.resolve();
            await release.promise;
          }
          ctx.afterCommit(() => {
            published.push(input);
          });
          return input;
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    groups.length = 0;
    const results = Promise.allSettled(
      ["one", "two", "three"].map((input) =>
        owner.execute("write", caller, { input })
      ),
    );
    await bounded(entered.promise, "bounded group");
    await assertRejects(
      () => owner.execute("write", caller, { input: "overflow" }),
      Error,
      "queue is full",
    );
    release.resolve();
    const settled = await results;
    assertEquals(groups, [["one", "two"], ["three"]]);
    assertEquals(settled.map((r) => r.status), [
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    assertEquals(published, ["one", "three"]);
  } finally {
    release.resolve();
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("a deadline crossed inside a group is evaluated at each command's own time", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "group_time";
  let now = 0;
  const owner = createOwnerCommands({
    session: db,
    schema,
    now: () => new Date(now += 1000),
    handlers: {
      check: {
        authorize(expiry: string, ctx) {
          if (ctx.commandTime >= expiry) throw new Error("lease expired");
        },
        execute(_input: string, ctx) {
          return ctx.commandTime;
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        owner.execute("check", caller, { input: new Date(2000).toISOString() })
      ),
    );
    assertEquals(results.map((r) => r.status), [
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    assertEquals(owner.state, "acquired");
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("a caught SQL failure cannot make singleton COMMIT report rolled-back writes as success", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = "group_caught_failure";
  const tables = createCoreTableNames(schema);
  const published: string[] = [];
  const owner = createOwnerCommands({
    session: db,
    schema,
    handlers: {
      write: {
        authorize() {},
        async execute(_input: unknown, ctx) {
          await ctx.transaction.query(
            `INSERT INTO ${tables.nodes}(id,namespace,type,name) VALUES('lost','space','item','lost')`,
          );
          try {
            await ctx.transaction.query("SELECT 1/0");
          } catch {
            /* A handler cannot un-abort SQL by catching its exception. */
          }
          ctx.afterCommit(() => {
            published.push("lost");
          });
          return "lost";
        },
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    await assertRejects(
      () => owner.execute("write", caller, { input: {} }),
      Error,
      "division by zero",
    );
    assertEquals(published, []);
    assertEquals((await db.query(`SELECT id FROM ${tables.nodes}`)).rows, []);
    assertEquals(owner.state, "acquired");
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});
