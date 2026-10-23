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
  projectionTransactions: Set<number>;
  /** Runs after the asset planning read, before commit, then disarms. */
  before?: { run: () => Promise<unknown> };
};

/** Counts what a session runs and can interleave a competitor before one. */
function recording(base: SqlSession, recorder: Recorder): SqlSession {
  const recorded = (executor: SqlExecutor, planning = false): SqlExecutor => ({
    query: async <TRow extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => {
      recorder.statements.push(text);
      if (text.includes("projection_current")) {
        recorder.projectionTransactions.add(recorder.transactions);
      }
      const result = await executor.query<TRow>(text, params);
      if (planning && text.includes("asset_idempotency")) {
        const hook = recorder.before;
        recorder.before = undefined;
        await hook?.run();
      }
      return result;
    },
  });
  const session = createSqlSession(base);
  session.query = recorded(base, true).query;
  session.transaction = (operation) => {
    recorder.transactions++;
    return base.transaction((transaction) => operation(recorded(transaction)));
  };
  return session;
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

const measure = async (recorder: Recorder, work: () => Promise<unknown>) => {
  recorder.statements.length = 0;
  recorder.transactions = 0;
  recorder.projectionTransactions.clear();
  await work();
  return { transactions: recorder.projectionTransactions.size };
};

async function adoptionScenarios(url: string) {
  const recorder: Recorder = {
    statements: [],
    transactions: 0,
    projectionTransactions: new Set(),
  };
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

    assert(
      recorder.statements.some((sql) => sql.includes("SET holder=holder")),
      "storage commands reach the epoch fence",
    );
    // A write's new asset is stored by the statement that commits the write.
    const created = await measure(
      recorder,
      () => notes.create({ id: "n1", content: "Adopted by the write" }),
    );
    assertEquals(
      created.transactions,
      1,
      "asset adoption shares the mutation transaction",
    );
    assert(
      recorder.statements.some((text) =>
        text.includes("adoption_rows") && text.includes("projection_current")
      ),
      "the asset is composed into the collection write",
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

    // A standalone publish is one statement after its key lookup.
    await measure(recorder, async () => {
      const asset = await measured.content.assets.publish({
        namespace,
        mediaType: "text/plain",
        body: new TextEncoder().encode("Published on its own"),
        idempotencyKey: "publish-alone",
      });
      assertEquals(asset.state, "ready");
    });
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

    // A taken id is still refused with the same error, by the commit.
    const [taken] = await assetIds();
    const conflict = await measured.content.assets.publish({
      namespace,
      id: taken,
      mediaType: "text/plain",
      body: new TextEncoder().encode("Another body"),
    }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    assertEquals(conflict?.code, "asset_conflict");
    assertEquals(await assetIds(), [...before, ...contendedAssets].sort());

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
    assert(
      recorder.statements.some((text) =>
        text.includes("adoption_rows") && text.includes("projection_current")
      ),
      "the joined writes compose their assets",
    );

    // A competitor commits the same content before the transaction takes its
    // locks: the transaction finds the key and reuses the competitor's asset.
    recorder.before = {
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
  } finally {
    await competitor.shutdown();
    await measured.shutdown();
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
