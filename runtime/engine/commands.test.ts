import { bounded } from "../testing/effect-commit-proxy.ts";
import { upgradeActionLifecycle } from "../actions/upgrade.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import {
  afterSqlCommit,
  type SqlExecutor,
  type SqlSession,
} from "../events/session.ts";
import { type CommandContext, createOwnerCommands } from "./commands.ts";

type Commands = {
  write: { input: { id: string; fail?: boolean }; output: { id: string } };
};

Deno.test("owner commands fence, serialize, replay receipts and isolate failed savepoints", async () => {
  const db = await createTestDatabase();
  const schema = "owner_commands";
  try {
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema);
    const statements: string[][] = [];
    let authorizations = 0;
    let writes = 0;
    let cached = 0;
    const published: string[] = [];
    const publicationDone = new Map(
      ["one", "two", "three"].map((id) => [id, Promise.withResolvers<void>()]),
    );
    let retained: SqlExecutor | undefined;
    let retainedContext: CommandContext | undefined;
    const times: string[] = [];
    const owner = createOwnerCommands<Commands>({
      session: {
        ...db,
        transaction(run) {
          const queries: string[] = [];
          statements.push(queries);
          return db.transaction((tx) =>
            run({
              query(sql, params) {
                queries.push(sql);
                return tx.query(sql, params);
              },
            })
          );
        },
      },
      schema,
      now: () => new Date(1_000 * (writes + 1)),
      handlers: {
        write: {
          authorize() {
            authorizations++;
          },
          async execute(input, context) {
            writes++;
            retained = context.transaction;
            retainedContext = context;
            times.push(context.commandTime);
            await context.transaction.query(
              `INSERT INTO ${tables.nodes} (id,namespace,type,name) VALUES ($1,'space','item',$1)`,
              [input.id],
            );
            afterSqlCommit(context.transaction, () => {
              cached++;
            });
            context.afterCommit(() => {
              published.push(input.id);
              publicationDone.get(input.id)?.resolve();
            });
            if (input.fail) throw new Error("handler failed");
            return { id: input.id };
          },
        },
      },
    });
    const epoch = await owner.acquire(0);
    const caller = { principal: "worker", epoch };
    const request = {
      input: { id: "one" },
      receipt: {
        identity: { domain: "logical" as const, key: "run/step" },
        intent: { id: "one" },
      },
    };
    assertEquals(await owner.execute("write", caller, request), { id: "one" });
    assertEquals(await owner.execute("write", caller, request), { id: "one" });
    assertThrows(
      () => retainedContext!.afterCommit(() => {}),
      Error,
      "active SQL transaction",
    );
    assertEquals(
      (await owner.readReceipt(
        { ...caller, epoch: 0 },
        request.receipt.identity,
      ))?.result,
      { id: "one" },
    );
    assertEquals(
      await owner.readReceipt(
        { ...caller, principal: "another" },
        request.receipt.identity,
      ),
      undefined,
    );
    await bounded(
      publicationDone.get("one")!.promise,
      "first owner publication",
    );
    assertEquals(writes, 1);
    assertEquals(authorizations, 2);
    assertEquals(cached, 1);
    assertEquals(published, ["one"]);
    await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
    await assertRejects(
      () =>
        owner.execute("write", caller, {
          ...request,
          receipt: { ...request.receipt, intent: { id: "other" } },
        }),
      Error,
      "another principal, kind or intent",
    );
    await assertRejects(
      () =>
        owner.execute("write", caller, { input: { id: "failed", fail: true } }),
      Error,
      "handler failed",
    );
    assertEquals(cached, 1);
    assertEquals(published, ["one"]);
    assertEquals(
      (await db.query(`SELECT id FROM ${tables.nodes} WHERE id='failed'`)).rows,
      [],
    );
    await Promise.all(
      ["two", "three"].map((id) =>
        owner.execute("write", caller, { input: { id } })
      ),
    );
    await bounded(
      Promise.all([...publicationDone.values()].map((done) => done.promise)),
      "committed owner publications",
    );
    assertEquals(times.length, 4);
    assertEquals(new Set(times).size, 4);
    assertEquals(cached, 3);
    assertEquals(published, ["one", "two", "three"]);
    for (const queries of statements.slice(1)) {
      assert(
        queries[0].startsWith(
          `UPDATE ${tables.owner_epochs} SET holder=holder`,
        ),
      );
    }
    assertEquals(owner.state, "acquired");
    owner.activate();
    await owner.ready;
    owner.stop();
  } finally {
    await db.close();
  }
});

Deno.test("owner bounds admission while SQL runs and never waits for publication", async () => {
  const db = await createTestDatabase();
  try {
    await provisionCopilotzSchema(db, "owner_capacity");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publishRelease = Promise.withResolvers<void>();
    const owner = createOwnerCommands<Commands>({
      session: db,
      schema: "owner_capacity",
      maxQueue: 2,
      handlers: {
        write: {
          authorize() {},
          async execute(input, context) {
            if (input.id === "one") {
              entered.resolve();
              await release.promise;
              context.afterCommit(() => publishRelease.promise);
            }
            return { id: input.id };
          },
        },
      },
    });
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    const first = owner.execute("write", caller, { input: { id: "one" } });
    await entered.promise;
    const second = owner.execute("write", caller, { input: { id: "two" } });
    await assertRejects(
      () => owner.execute("write", caller, { input: { id: "three" } }),
      Error,
      "queue is full",
    );
    release.resolve();
    assertEquals(await first, { id: "one" });
    assertEquals(await second, { id: "two" });
    publishRelease.resolve();
    owner.stop();
  } finally {
    await db.close();
  }
});

Deno.test("unknown command commit stops the owner and prevents readiness", async () => {
  const db = await createTestDatabase();
  try {
    const schema = "owner_unknown";
    await provisionCopilotzSchema(db, schema);
    let loseCommit = false;
    let published = false;
    const session: SqlSession = {
      ...db,
      async transaction(run) {
        const result = await db.transaction(run);
        if (loseCommit) throw new Error("commit acknowledgement lost");
        return result;
      },
    };
    const owner = createOwnerCommands<Commands>({
      session,
      schema,
      handlers: {
        write: {
          authorize() {},
          execute(input, context) {
            context.afterCommit(() => {
              published = true;
            });
            return { id: input.id };
          },
        },
      },
    });
    const caller = { principal: "worker", epoch: await owner.acquire(0) };
    loseCommit = true;
    await assertRejects(
      () =>
        owner.execute("write", caller, {
          input: { id: "one" },
          receipt: {
            identity: { domain: "occurrence", key: "scheduled" },
            intent: {},
          },
        }),
      Error,
      "outcome is unknown",
    );
    await assertRejects(() => owner.ready, Error, "outcome is unknown");
    assertEquals(owner.state, "stopped");
    assertEquals(published, false);
    assertEquals(
      (await db.query(
        `SELECT key FROM ${createCoreTableNames(schema).owner_receipts}`,
      )).rows,
      [{ key: "scheduled" }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("versioned owner upgrade preserves an existing event and Action baseline", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `owner_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const tables = createCoreTableNames(schema);
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    await db.query(
      `INSERT INTO ${tables.events} (seq,id,schema_version,type,namespace,payload,correlation_id) VALUES (1,'existing',1,'test.event','space','{}','existing')`,
    );
    await db.query(
      `DROP TABLE ${tables.owner_event_sequences}, ${tables.owner_body_retirements}, ${tables.owner_deadlines}, ${tables.owner_alarms}, ${tables.owner_receipts}, ${tables.owner_epochs}`,
    );
    await db.query(`UPDATE ${tables.copilotz_schema_metadata} SET version=8`);
    await upgradeActionLifecycle(db, schema);
    assertEquals(
      (await provisionCopilotzSchema(db, schema)).version,
      EVENT_SCHEMA_VERSION,
    );
    assertEquals((await db.query(`SELECT id FROM ${tables.events}`)).rows, [{
      id: "existing",
    }]);
    assertEquals(
      (await provisionCopilotzSchema(db, schema)).version,
      EVENT_SCHEMA_VERSION,
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
Deno.test({
  name:
    "Postgres takeover waits on the fence and rejects the old holder's next write",
  ignore: !postgres,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const first = await createTestDatabase({ url: postgres! });
    const second = await createTestDatabase({ url: postgres! });
    const schema = `owner_${crypto.randomUUID().replaceAll("-", "")}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await provisionCopilotzSchema(first, schema);
      const handlers = {
        write: {
          authorize() {},
          async execute(input: { id: string }, _context: CommandContext) {
            if (input.id === "hold") {
              entered.resolve();
              await release.promise;
            }
            return input;
          },
        },
      };
      const old = createOwnerCommands<Commands>({
        session: first,
        schema,
        handlers,
      });
      const epoch = await old.acquire(0);
      const write = old.execute("write", { principal: "worker", epoch }, {
        input: { id: "hold" },
      });
      await entered.promise;
      const successor = createOwnerCommands<Commands>({
        session: second,
        schema,
        handlers,
      });
      let acquired = false;
      const takeover = successor.acquire(epoch).then((value) => {
        acquired = true;
        return value;
      });
      // A query on another connection completes while the epoch lock is held.
      await first.query("SELECT 1");
      assertEquals(acquired, false);
      release.resolve();
      await write;
      assertEquals(await takeover, epoch + 1);
      await assertRejects(
        () =>
          old.execute("write", { principal: "worker", epoch }, {
            input: { id: "stale" },
          }),
        Error,
        "no longer current",
      );
      assertEquals(old.state, "stopped");
      successor.stop();
    } finally {
      release.resolve();
      await first.query(`DROP SCHEMA "${schema}" CASCADE`);
      await first.close();
      await second.close();
    }
  },
});

Deno.test({
  name:
    "Postgres command rejection rolls back its savepoint and keeps the owner usable",
  ignore: !postgres,
  async fn() {
    const db = await createTestDatabase({ url: postgres! });
    const schema = `owner_rejection_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const tables = createCoreTableNames(schema);
      const owner = createOwnerCommands({
        session: db,
        schema,
        handlers: {
          write: {
            authorize() {},
            async execute(
              input: { id: string; reject: boolean },
              { transaction },
            ) {
              await transaction.query(
                `INSERT INTO ${tables.nodes} (id,namespace,type,name) VALUES ($1,'space','item',$1)`,
                [input.id],
              );
              if (input.reject) throw new Error("command refused");
              return input.id;
            },
          },
        },
      });
      const caller = { principal: "runtime", epoch: await owner.acquire(0) };
      await assertRejects(
        () =>
          owner.execute("write", caller, {
            input: { id: "refused", reject: true },
          }),
        Error,
        "command refused",
      );
      assertEquals(owner.state, "acquired");
      assertEquals(
        await owner.execute("write", caller, {
          input: { id: "kept", reject: false },
        }),
        "kept",
      );
      assertEquals((await db.query(`SELECT id FROM ${tables.nodes}`)).rows, [{
        id: "kept",
      }]);
      owner.stop();
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});

Deno.test("a second owner cannot acquire the same observed schema epoch", async () => {
  const db = await createTestDatabase();
  const schema = "owner_rejection";
  try {
    await provisionCopilotzSchema(db, schema);
    const first = createOwnerCommands({ session: db, schema, handlers: {} });
    const second = createOwnerCommands({ session: db, schema, handlers: {} });
    await first.acquire(0);
    await assertRejects(
      () => second.acquire(0),
      Error,
      "Another owner acquired",
    );
    assertEquals(first.state, "acquired");
    assertEquals(second.state, "stopped");
    first.stop();
  } finally {
    await db.close();
  }
});
