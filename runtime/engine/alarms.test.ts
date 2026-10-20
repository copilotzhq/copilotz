import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createOwnerCommands, type DatabaseOwner } from "./commands.ts";
import {
  completeOwnerDeadline,
  type OwnerDeadline,
  reconciliationAlarmKey,
  writeOwnerDeadline,
} from "./alarms.ts";

function clock() {
  let time = Date.parse("2026-01-01T00:00:00Z");
  const timers = new Map<number, { callback(): void; delay: number }>();
  let serial = 0;
  return {
    now: () => new Date(time),
    timers,
    advance(ms: number) {
      time += ms;
    },
    scheduler: {
      schedule(callback: () => void, delay: number) {
        const id = ++serial;
        timers.set(id, { callback, delay });
        return id;
      },
      cancel(handle: unknown) {
        timers.delete(handle as number);
      },
    },
  };
}

Deno.test("owner keeps one earliest committed alarm through insert cancel complete and rollback", async () => {
  const db = await createTestDatabase();
  const schema = "alarm_earliest";
  const time = clock();
  await provisionCopilotzSchema(db, schema);
  const owner = createOwnerCommands({
    session: db,
    schema,
    handlers: {},
    now: time.now,
    alarmScheduler: time.scheduler,
  });
  const tables = createCoreTableNames(schema);
  await owner.acquire(0);
  const write = owner.register("test.deadline", {
    authorize() {},
    async execute(
      input: { key: string; dueAt: string | null; fail?: boolean },
      context,
    ) {
      await writeOwnerDeadline(context.transaction, schema, {
        source: "test",
        key: input.key,
        namespace: "space",
        dueAt: input.dueAt,
      });
      if (input.fail) throw new Error("rollback");
    },
  });
  const send = (key: string, offset: number | null, fail = false) =>
    write({ principal: "test", epoch: owner.epoch! }, {
      input: {
        key,
        dueAt: offset === null
          ? null
          : new Date(time.now().getTime() + offset).toISOString(),
        fail,
      },
    });
  const fired: string[] = [];
  const complete = owner.register("test.complete", {
    authorize() {},
    async execute(deadline: OwnerDeadline, context) {
      await completeOwnerDeadline(context.transaction, schema, deadline);
    },
  });
  owner.registerAlarmSource({
    name: "test",
    async wake(deadlines) {
      for (const deadline of deadlines) {
        await complete({ principal: "test", epoch: owner.epoch! }, {
          input: deadline,
        });
        fired.push(deadline.key);
      }
    },
  });
  const alarm = async () =>
    (await db.query<{ due_at: string | Date }>(
      `SELECT due_at FROM ${tables.owner_alarms}`,
    )).rows;
  try {
    await send("later", 20_000);
    await send("first", 10_000);
    assertEquals((await alarm()).length, 1);
    assertEquals(
      new Date((await alarm())[0].due_at).getTime(),
      time.now().getTime() + 10_000,
    );
    assertEquals(time.timers.size, 0, "readiness gates the platform alarm");
    await assertRejects(() => send("rolled-back", 1, true), Error, "rollback");
    assertEquals(
      (await db.query(`SELECT key FROM ${tables.owner_deadlines} ORDER BY key`))
        .rows,
      [{ key: "first" }, { key: "later" }],
    );
    owner.activate();
    await owner.rearmAlarms();
    assertEquals(time.timers.size, 1);
    await send("first", null);
    await owner.rearmAlarms();
    assertEquals([...time.timers.values()][0].delay, 20_000);
    time.advance(20_000);
    await owner.wakeAlarms();
    assertEquals(fired, ["later"]);
    assertEquals(await alarm(), []);
    assertEquals(time.timers.size, 0);
    await owner.wakeAlarms();
    assertEquals(
      fired,
      ["later"],
      "an empty owner does not poll or repeat completed work",
    );
  } finally {
    owner.stop();
    await db.close();
  }
});

Deno.test("deadline completion cannot erase replacement or recreated work with the same due timestamp", async () => {
  const db = await createTestDatabase();
  const schema = "alarm_revision";
  await provisionCopilotzSchema(db, schema);
  const owner = createOwnerCommands({ session: db, schema, handlers: {} });
  await owner.acquire(0);
  const run = owner.register("test.replace", {
    authorize() {},
    async execute(_input: unknown, context) {
      const input = {
        source: "test",
        key: "key",
        namespace: "space",
        dueAt: context.commandTime,
      };
      await writeOwnerDeadline(context.transaction, schema, input);
      const selected =
        (await context.transaction.query<{ revision: string | number }>(
          `SELECT revision FROM ${
            createCoreTableNames(schema).owner_deadlines
          }`,
        )).rows[0];
      await writeOwnerDeadline(context.transaction, schema, {
        ...input,
        dueAt: null,
      });
      await writeOwnerDeadline(context.transaction, schema, input);
      await completeOwnerDeadline(context.transaction, schema, {
        ...input,
        payload: null,
        revision: String(selected.revision),
      });
    },
  });
  try {
    await run({ principal: "test", epoch: owner.epoch! }, { input: {} });
    assertEquals(
      (await db.query(
        `SELECT key FROM ${createCoreTableNames(schema).owner_deadlines}`,
      )).rows,
      [{ key: "key" }],
    );
  } finally {
    owner.stop();
    await db.close();
  }
});

Deno.test("takeover re-arms the retained wake and fences the old callback", async () => {
  const db = await createTestDatabase();
  const schema = "alarm_takeover";
  const time = clock();
  await provisionCopilotzSchema(db, schema);
  const options = {
    session: db,
    schema,
    handlers: {},
    now: time.now,
    alarmScheduler: time.scheduler,
  };
  const first = createOwnerCommands(options);
  const second = createOwnerCommands(options);
  let handled = 0;
  function install(owner: DatabaseOwner) {
    const finish = owner.register("test.finish", {
      authorize() {},
      async execute(deadline: OwnerDeadline, context) {
        await completeOwnerDeadline(context.transaction, schema, deadline);
      },
    });
    owner.registerAlarmSource({
      name: "test",
      async wake(deadlines) {
        for (const deadline of deadlines) {
          await finish({ principal: "test", epoch: owner.epoch! }, {
            input: deadline,
          });
          handled++;
        }
      },
    });
  }
  try {
    await first.acquire(0);
    install(first);
    const put = first.register("test.put", {
      authorize() {},
      execute(_input: unknown, context) {
        return writeOwnerDeadline(context.transaction, schema, {
          source: "test",
          key: "retained",
          namespace: "space",
          dueAt: new Date(time.now().getTime() + 1000).toISOString(),
        });
      },
    });
    await put({ principal: "test", epoch: first.epoch! }, { input: {} });
    first.activate();
    await first.rearmAlarms();
    await second.acquire(first.epoch!);
    install(second);
    second.activate();
    await second.rearmAlarms();
    time.advance(1000);
    await assertRejects(() => first.wakeAlarms(), Error, "no longer current");
    assertEquals(first.state, "stopped");
    await second.wakeAlarms();
    assertEquals(handled, 1);
    assertEquals(
      (await db.query(
        `SELECT * FROM ${createCoreTableNames(schema).owner_alarms}`,
      )).rows,
      [],
    );
  } finally {
    first.stop();
    second.stop();
    await db.close();
  }
});

Deno.test("reconciliation identity preserves namespace nulls and escaping", () => {
  const values = [null, "", "a/b", 'a"b', "a\\b"];
  const keys = values.map((namespace) =>
    reconciliationAlarmKey("owner", { kind: "operation", namespace, id: "a/b" })
  );
  assertEquals(new Set(keys).size, values.length);
  for (let i = 0; i < values.length; i++) {
    assertEquals(JSON.parse(keys[i]), [
      "reconciliation",
      "owner",
      "operation",
      values[i],
      "a/b",
    ]);
  }
  assert(keys.every((key) => key.length > 0));
});

Deno.test("unrelated commands neither refresh deadline sources nor read or rewrite alarms", async () => {
  const db = await createTestDatabase();
  const schema = "alarm_incremental";
  const sql: string[] = [];
  await provisionCopilotzSchema(db, schema);
  const owner = createOwnerCommands({
    schema,
    handlers: {},
    session: {
      query: db.query,
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query(statement, params) {
              sql.push(statement);
              return tx.query(statement, params);
            },
          })
        ),
    },
  });
  let refreshed = 0;
  owner.registerAlarmSource({
    name: "content",
    nextDeadline() {
      refreshed++;
      return Promise.resolve(null);
    },
    wake() {
      return Promise.resolve();
    },
  });
  try {
    await owner.acquire(0);
    const noop = owner.register("test.read", {
      authorize() {},
      execute() {
        return 1;
      },
    });
    sql.length = 0;
    assertEquals(
      await noop({ principal: "test", epoch: owner.epoch! }, { input: {} }),
      1,
    );
    assertEquals(refreshed, 0);
    assert(
      !sql.some((statement) => /owner_alarms|owner_deadlines/.test(statement)),
    );
  } finally {
    owner.stop();
    await db.close();
  }
});
