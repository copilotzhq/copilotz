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
import { readViews } from "./read-view.ts";

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

/**
 * A handler reads through a view of its own: a row it has read is not asked
 * for again, its own writes are always seen, and a snapshot is never served
 * from it.
 */
async function hopViewScenarios(url: string) {
  const recorder: Recorder = { statements: [], readSnapshots: 0 };
  const db = await createTestDatabase({ url });
  const schema = "hop_" + crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "hop",
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
    return await work();
  };
  // Another process changing a row: this engine's kernel never hears of it.
  const changeElsewhere = (id: string, title: string) =>
    db.query(
      `UPDATE "${schema}"."nodes" SET data = jsonb_set(data, '{title}', $3::jsonb)
       WHERE namespace = $1 AND data->>'id' = $2`,
      [namespace, id, JSON.stringify(title)],
    );
  try {
    for (const id of ["a", "b"]) {
      await notes.create({ id, title: `Note ${id}` });
    }
    await notes.create({
      id: "big",
      title: "Note big",
      content: "x".repeat(2_000),
    });

    // Within a hop a row is asked for once, however the reads are sequenced.
    const twice = await measure(() =>
      readViews.run(async () => {
        const first = await notes.get({ id: "a" });
        const second = await notes.get({ id: "a" });
        const missing = await notes.get({ id: "nope" });
        const missingAgain = await notes.get({ id: "nope" });
        return { first, second, missing, missingAgain };
      })
    );
    assertEquals(recordReads(recorder).length, 2, "one per distinct row");
    assertEquals(twice.first, twice.second);
    assert(twice.first !== twice.second, "each read has its own copy");
    assertEquals(twice.missing, null);
    assertEquals(twice.missingAgain, null);

    // Two hops never share what they read.
    const hop = () =>
      readViews.run(async () => {
        await notes.get({ id: "a" });
        await notes.get({ id: "a" });
      });
    await measure(async () => {
      await hop();
      await hop();
    });
    assertEquals(recordReads(recorder).length, 2, "one per hop");

    // A hop always sees its own writes, including a create over a miss.
    await readViews.run(async () => {
      assertEquals(await notes.get({ id: "fresh" }), null);
      await notes.create({ id: "fresh", title: "Created" });
      assertEquals((await notes.get({ id: "fresh" }))?.title, "Created");
      await notes.update({ id: "fresh", set: { title: "Updated" } });
      assertEquals((await notes.get({ id: "fresh" }))?.title, "Updated");
      await notes.delete({ id: "fresh" });
      assertEquals(await notes.get({ id: "fresh" }), null);
    });

    // Someone else's write is seen by the next hop, and by any read that is
    // not inside one; within a hop it is allowed to be as old as the hop.
    await readViews.run(async () => {
      assertEquals((await notes.get({ id: "b" }))?.title, "Note b");
      await changeElsewhere("b", "Elsewhere");
      assertEquals((await notes.get({ id: "b" }))?.title, "Note b");
    });
    assertEquals((await notes.get({ id: "b" }))?.title, "Elsewhere");
    await readViews.run(async () => {
      assertEquals((await notes.get({ id: "b" }))?.title, "Elsewhere");
    });

    // A snapshot is one consistent point in time and is never served from
    // what the hop remembered.
    await readViews.run(async () => {
      assertEquals((await notes.get({ id: "a" }))?.title, "Note a");
      await changeElsewhere("a", "Later");
      const snapshotted = await engine.collections.readSnapshot(
        { namespace },
        ({ collections }) => collections.note.get({ id: "a" }),
      );
      assertEquals(snapshotted?.title, "Later");
    });

    // Asset rows are remembered too, so a second bound is decided without
    // asking the database again, and is still enforced.
    await readViews.run(async () => {
      await notes.get({ id: "big" }, { content: { byteLimit: 10_000 } });
      const before = assetReads(recorder).length;
      await assertRejects(
        () => notes.get({ id: "big" }, { content: { byteLimit: 10 } }),
        RangeError,
      );
      assertEquals(assetReads(recorder).length, before);
    });
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite a handler reads through a view of its own", () =>
  hopViewScenarios(":memory:"));

Deno.test({
  name: "PostgreSQL a handler reads through a view of its own",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => hopViewScenarios(POSTGRES_URL!),
});
