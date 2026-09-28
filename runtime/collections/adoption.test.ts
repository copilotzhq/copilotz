import { assert, assertEquals } from "@std/assert";

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
      content: {},
    },
    required: ["id", "content"],
  },
  content: { fields: ["content"] },
});

type Recorder = {
  statements: string[];
  transactions: number;
  /** Runs before the first statement matching `pattern`, then disarms. */
  before?: { pattern: RegExp; run: () => Promise<unknown> };
};

/** Counts what a session runs and can interleave a competitor before one. */
function recording(base: SqlSession, recorder: Recorder): SqlSession {
  const recorded = (executor: SqlExecutor): SqlExecutor => ({
    query: async <TRow extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => {
      recorder.statements.push(text);
      const hook = recorder.before;
      if (hook && hook.pattern.test(text)) {
        recorder.before = undefined;
        await hook.run();
      }
      return await executor.query<TRow>(text, params);
    },
  });
  return {
    ...recorded(base),
    transaction: (operation) => {
      recorder.transactions++;
      return base.transaction((transaction) =>
        operation(recorded(transaction))
      );
    },
  };
}

async function createEngines(url: string, recorder: Recorder) {
  const db = await createTestDatabase({ url });
  const schema = "adoption_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "adoption",
      version: "1",
      collections: { note },
    })],
  });
  const engine = (session: SqlSession) =>
    createCopilotzEngine({
      session,
      registry,
      defaultDatabaseSchema: schema,
    });
  const measured = await engine(recording(createSqlSession(db), recorder));
  const competitor = await engine(createSqlSession(db));
  return { db, schema, measured, competitor };
}

/** The statements that change data. */
const writes = (recorder: Recorder) =>
  recorder.statements.filter((text) =>
    /^\s*(WITH|INSERT|UPDATE|DELETE)\b/.test(text)
  ).length;

const measure = async (recorder: Recorder, work: () => Promise<unknown>) => {
  recorder.statements.length = 0;
  recorder.transactions = 0;
  await work();
  return {
    statements: recorder.statements.length,
    transactions: recorder.transactions,
  };
};

async function adoptionScenarios(url: string) {
  const recorder: Recorder = { statements: [], transactions: 0 };
  const { db, schema, measured, competitor } = await createEngines(
    url,
    recorder,
  );
  const namespace = "tenant";
  const notes = measured.collections.withScope({ namespace }).note;
  const rivals = competitor.collections.withScope({ namespace }).note;
  const assetIds = async () =>
    (await db.query<{ id: string }>(
      `SELECT id FROM "${schema}".nodes WHERE type = 'asset' ORDER BY id`,
    )).rows.map((row) => row.id);
  try {
    // The first write provisions the body tables.
    await notes.create({ id: "warm", content: "Warm up" });

    // A write's new asset is stored by the statement that commits the write.
    const created = await measure(
      recorder,
      () => notes.create({ id: "n1", content: "Adopted by the write" }),
    );
    assertEquals(created.transactions, 0, "a new asset needs no transaction");
    assert(
      recorder.statements.some((text) =>
        text.includes("adoption_rows") && text.includes("projection_current")
      ),
      "the asset is composed into the collection write",
    );
    assertEquals(
      writes(recorder),
      1,
      "the event, the asset and the projection are one statement",
    );
    // Reads that hydrate the written content are outside the write.
    assert(
      created.statements <= 6,
      `a content write took ${created.statements} statements`,
    );
    const stored = await notes.get({ id: "n1" }, { content: true });
    assertEquals(
      (stored?.content as { value: unknown }[])[0].value,
      "Adopted by the write",
    );

    // The same content reuses the asset it already has.
    const before = await assetIds();
    await notes.create({ id: "n2", content: "Adopted by the write" });
    assertEquals(await assetIds(), before);

    // A standalone publish is one statement after its two reads.
    const published = await measure(recorder, async () => {
      const asset = await measured.content.assets.publish({
        namespace,
        mediaType: "text/plain",
        body: new TextEncoder().encode("Published on its own"),
        idempotencyKey: "publish-alone",
      });
      assertEquals(asset.state, "ready");
    });
    assertEquals(published.transactions, 0);
    assertEquals(writes(recorder), 1, "a publish is one writing statement");
    assert(
      published.statements <= 3,
      `a publish took ${published.statements} statements`,
    );
    const [readBack] = await measured.content.assets.readMany(namespace, [
      (await assetIds()).find((id) => !before.includes(id))!,
    ]);
    assertEquals(
      new TextDecoder().decode(readBack.bytes),
      "Published on its own",
    );

    // A competitor stores the same content between this write's planning and
    // its commit. The write's statement finds the key taken, so the write
    // reconciles onto the competitor's asset instead of adding another.
    recorder.before = {
      pattern: /projection_current/,
      run: () => rivals.create({ id: "rival", content: "Contended content" }),
    };
    await notes.create({ id: "loser", content: "Contended content" });
    assertEquals(recorder.before, undefined, "the competitor ran");
    const contended = await Promise.all(
      ["rival", "loser"].map((id) => notes.get({ id }, { content: true })),
    );
    const refs = await Promise.all(
      ["rival", "loser"].map((id) => notes.get({ id })),
    );
    for (const row of contended) {
      assertEquals(
        (row?.content as { value: unknown }[])[0].value,
        "Contended content",
      );
    }
    assertEquals(
      new Set(
        refs.map((row) => (row?.content as { assetId: string }[])[0].assetId),
      ).size,
      1,
      "both notes reference one asset",
    );
    const contendedAssets = (await assetIds()).filter((id) =>
      !before.includes(id)
    );
    // The published asset and the single contended asset.
    assertEquals(contendedAssets.length, 2);

    // Writes that share a transaction each adopt their assets in their own
    // statement, after one reconcile of the keys the transaction holds.
    const both = await measure(
      recorder,
      () =>
        measured.collections.transaction({
          operationKey: "adoption:pair",
          namespace,
          async execute({ collections }) {
            await collections.note.create({ id: "p1", content: "Pair one" });
            await collections.note.create({ id: "p2", content: "Pair two" });
          },
        }),
    );
    assertEquals(both.transactions, 1);
    assertEquals(writes(recorder), 2, "each write is one statement");
    assert(
      recorder.statements.some((text) =>
        text.includes("adoption_rows") && text.includes("projection_current")
      ),
      "the joined writes compose their assets",
    );

    // A competitor commits the same content before the transaction takes its
    // locks: the transaction finds the key and reuses the competitor's asset.
    recorder.before = {
      pattern: /pg_advisory_xact_lock/,
      run: () => rivals.create({ id: "early", content: "Early content" }),
    };
    await measured.collections.transaction({
      operationKey: "adoption:joined-race",
      namespace,
      async execute({ collections }) {
        await collections.note.create({ id: "late", content: "Early content" });
      },
    });
    assertEquals(recorder.before, undefined, "the competitor ran");
    const shared = await Promise.all(
      ["early", "late"].map((id) => notes.get({ id })),
    );
    assertEquals(
      new Set(
        shared.map((row) => (row?.content as { assetId: string }[])[0].assetId),
      ).size,
      1,
      "both notes reference one asset",
    );

    // Rebuilding from events reproduces the same graph.
    const graph = () =>
      db.query(
        `SELECT id, type, data FROM "${schema}".nodes ORDER BY id`,
      ).then((result) => result.rows);
    const projected = await graph();
    await measured.collections.rebuild(namespace);
    assertEquals(await graph(), projected);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite adopts a write's assets in its own statement", () =>
  adoptionScenarios(":memory:"));

Deno.test({
  name: "PostgreSQL adopts a write's assets in its own statement",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => adoptionScenarios(POSTGRES_URL!),
});
