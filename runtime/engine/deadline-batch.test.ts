import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createOwnerCommands } from "./commands.ts";
import {
  completeOwnerDeadlines,
  type OwnerDeadline,
  writeOwnerDeadline,
} from "./alarms.ts";

Deno.test("batched deadline acknowledgments preserve re-armed revisions and roll back atomically", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 1,
  });
  const schema = `perf_deadlines_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = createOwnerCommands({ session: db, schema, handlers: {} });
  await owner.acquire(0);
  const caller = { principal: "test", epoch: owner.epoch! };
  const write = owner.register("write", {
    authorize() {},
    async execute(keys: string[], { transaction }) {
      for (const key of keys) {
        await writeOwnerDeadline(transaction, schema, {
          source: "test",
          key,
          namespace: "space",
          dueAt: "2100-01-01T00:00:00.000Z",
        });
      }
    },
  });
  const complete = owner.register("complete", {
    authorize() {},
    async execute(
      input: { deadlines: OwnerDeadline[]; fail?: boolean },
      { transaction },
    ) {
      await completeOwnerDeadlines(transaction, schema, input.deadlines);
      if (input.fail) throw new Error("rollback");
    },
  });
  const remaining = async () =>
    (await db.query<{ key: string }>(
      `SELECT key FROM "${schema}".owner_deadlines ORDER BY key`,
    )).rows.map((row) => row.key);
  try {
    await write(caller, { input: ["a", "b", "c"] });
    const deadlines = (await db.query<{
      key: string;
      revision: string;
    }>(
      `SELECT key,revision::text FROM "${schema}".owner_deadlines ORDER BY key`,
    )).rows.map((row): OwnerDeadline => ({
      ...row,
      source: "test",
      namespace: "space",
      dueAt: "2100-01-01T00:00:00.000Z",
      payload: null,
    }));
    await write(caller, { input: ["b"] });
    await assertRejects(
      () => complete(caller, { input: { deadlines, fail: true } }),
      Error,
      "rollback",
    );
    assertEquals(await remaining(), ["a", "b", "c"]);
    await complete(caller, { input: { deadlines } });
    assertEquals(await remaining(), ["b"]);
    await complete(caller, { input: { deadlines } });
    await complete(caller, { input: { deadlines: [] } });
    assertEquals(await remaining(), ["b"]);
  } finally {
    await owner.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
