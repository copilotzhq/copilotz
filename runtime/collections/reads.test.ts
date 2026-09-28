import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import {
  createSqlSession,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineCollection } from "./definition.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

const note = defineCollection({
  name: "note",
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      content: {},
    },
    required: ["id", "title"],
  },
  content: { fields: ["content"] },
});

type Recorder = { statements: string[]; readSnapshots: number };

/** Counts every statement a session runs, inside or outside a transaction. */
function recording(base: SqlSession, recorder: Recorder): SqlSession {
  const recorded = (executor: SqlExecutor): SqlExecutor => ({
    query: <TRow extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => {
      recorder.statements.push(text);
      return executor.query<TRow>(text, params);
    },
  });
  return {
    ...recorded(base),
    transaction: (operation) =>
      base.transaction((transaction) => operation(recorded(transaction))),
    readSnapshot: (operation) => {
      recorder.readSnapshots++;
      return base.readSnapshot!((snapshot) => operation(recorded(snapshot)));
    },
  };
}

/** Selects from the graph's nodes, which is where every record read lands. */
const nodeReads = (recorder: Recorder) =>
  recorder.statements.filter((text) =>
    /^\s*SELECT\b/.test(text) && text.includes(`"nodes"`)
  );

const recordReads = (recorder: Recorder) =>
  nodeReads(recorder).filter((text) => !text.includes("'asset'"));
const assetReads = (recorder: Recorder) =>
  nodeReads(recorder).filter((text) => text.includes("'asset'"));

async function readScenarios(url: string) {
  const recorder: Recorder = { statements: [], readSnapshots: 0 };
  const db = await createTestDatabase({ url });
  const schema = "reads_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "reads",
      version: "1",
      collections: { note },
    })],
  });
  const engine = await createCopilotzEngine({
    session: recording(createSqlSession(db), recorder),
    registry,
    defaultDatabaseSchema: schema,
  });
  const namespace = "tenant";
  const notes = engine.collections.withScope({ namespace }).note;
  const measure = async <T>(work: () => Promise<T>) => {
    recorder.statements.length = 0;
    const value = await work();
    return value;
  };
  try {
    for (const id of ["a", "b", "c"]) {
      await notes.create({ id, title: `Note ${id}` });
    }
    await notes.create({
      id: "big",
      title: "Note big",
      content: "x".repeat(2_000),
    });

    // Reads issued together are one statement, in any mix of hits and misses.
    const together = await measure(() =>
      Promise.all(
        ["a", "b", "missing", "c", "a"].map((id) => notes.get({ id })),
      )
    );
    assertEquals(
      recordReads(recorder).length,
      1,
      "one statement for five gets",
    );
    assertEquals(
      together.map((row) => row?.title ?? null),
      ["Note a", "Note b", null, "Note c", "Note a"],
    );
    assert(together[0] !== together[4], "duplicate ids do not share an object");
    (together[0] as unknown as { title: string }).title = "changed";
    assertEquals(together[4]?.title, "Note a");

    // Reads that wait on each other stay separate: nothing is cached outside
    // a snapshot, so another writer's change is always seen.
    await measure(async () => {
      await notes.get({ id: "a" });
      await notes.get({ id: "a" });
    });
    assertEquals(recordReads(recorder).length, 2);
    await notes.update({ id: "a", set: { title: "Renamed" } });
    assertEquals((await notes.get({ id: "a" }))?.title, "Renamed");

    // Inside a snapshot the same question is asked once.
    const inside = await measure(() =>
      engine.collections.readSnapshot(
        { namespace },
        async ({ collections }) => {
          const first = await collections.note.get({ id: "a" });
          const second = await collections.note.get({ id: "a" });
          const listed = await collections.note.list({
            where: { title: "Renamed" },
          });
          const again = await collections.note.list({
            where: { title: "Renamed" },
          });
          const other = await collections.note.list({
            where: { title: "Note b" },
          });
          return { first, second, listed, again, other };
        },
      )
    );
    assertEquals(recorder.readSnapshots, 1);
    assertEquals(
      recordReads(recorder).length,
      3,
      "one get, and one statement for each distinct list",
    );
    assertEquals(inside.first?.title, "Renamed");
    assertEquals(inside.second, inside.first);
    assert(inside.second !== inside.first, "each read has its own copy");
    assertEquals(inside.listed, inside.again);
    assert(inside.listed !== inside.again);
    assertEquals(inside.other.map((row) => row.id), ["b"]);

    // A bounded read decides from the asset rows it already holds: one asset
    // statement whether the budget is met or not.
    const refused = await measure(() =>
      assertRejects(
        () => notes.get({ id: "big" }, { content: { byteLimit: 10 } }),
        RangeError,
      )
    );
    assertEquals(refused.name, "ContentByteLimitError");
    assertEquals(assetReads(recorder).length, 1);
    const allowed = await measure(() =>
      notes.get({ id: "big" }, { content: { byteLimit: 10_000 } })
    );
    assertEquals(assetReads(recorder).length, 1);
    assertEquals(
      (allowed?.content as { value: string }[])[0].value.length,
      2_000,
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite reads are batched, memoized in a snapshot and bounded once", () =>
  readScenarios(":memory:"));

Deno.test({
  name: "PostgreSQL reads are batched, memoized in a snapshot and bounded once",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => readScenarios(POSTGRES_URL!),
});
