import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineCollection } from "./definition.ts";

const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

async function concurrentContent(url: string) {
  const db = await createTestDatabase({ url });
  const schema = "content_race_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "content-race",
      version: "1",
      collections: {
        note: defineCollection({
          name: "note",
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              content: {},
              marker: { type: "string" },
            },
            required: ["id", "content"],
          },
          content: { fields: ["content"] },
        }),
      },
    })],
  });
  const engines: Awaited<ReturnType<typeof createCopilotzEngine>>[] = [];
  for (let i = 0; i < 2; i++) {
    engines.push(
      await createCopilotzEngine({
        session: createSqlSession(db),
        registry,
        defaultDatabaseSchema: schema,
      }),
    );
  }
  const notes = engines[0].collections.withScope({ namespace: "tenant" }).note;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => release = resolve);
  let planned = 0;
  const calls = [0, 0, 0];
  const write = (index: number, gate = true) =>
    engines[index % 2].collections.transaction({
      namespace: "tenant",
      operationKey: `write-${index}`,
      async execute({ collections }) {
        calls[index]++;
        await collections.note.create({
          id: `note-${index}`,
          content: "Same question",
        });
        // The second mutation's expected record also contains the provisional ref.
        await collections.note.update({
          id: `note-${index}`,
          set: { marker: "updated" },
        });
        if (gate) {
          if (++planned === 3) release();
          await barrier;
        }
      },
    });
  try {
    await Promise.all([0, 1, 2].map((index) => write(index)));
    assertEquals(calls, [1, 1, 1]);
    const records = await notes.list({}, { content: true });
    assertEquals(records.length, 3);
    const ids = records.map((row) =>
      (row.content as { assetId: string; value: unknown }[])[0].assetId
    );
    assertEquals(new Set(ids).size, 1);
    for (const row of records) {
      assertEquals(
        (row.content as { value: unknown }[])[0].value,
        "Same question",
      );
      assertEquals(row.marker, "updated");
    }
    const assets = await db.query(
      `SELECT id FROM "${schema}".nodes WHERE type='asset'`,
    );
    assertEquals(assets.rows.length, 1);
    assertEquals(assets.rows[0].id, ids[0]);
    const bodies = await db.query<
      {
        body: {
          record: { content: { assetId: string }[] };
          assets: { assetId: string }[];
        };
      }
    >(
      `SELECT b.body FROM "${schema}".event_bodies b JOIN "${schema}".events e
       ON e.payload->'dataRef'->>'eventBodyId'=b.event_body_id
       WHERE e.type IN ('note.created','note.updated')`,
    );
    for (const { body } of bodies.rows) {
      assertEquals(body.record.content[0].assetId, ids[0]);
      for (const manifest of body.assets) {
        assertEquals(manifest.assetId, ids[0]);
      }
    }
    await Promise.all([0, 1, 2].map((index) => write(index, false)));
    assertEquals((await notes.list({})).length, 3);
    assertEquals(await notes.list({}, { content: true }), records);

    // A genuine record conflict still rolls back every earlier write in the plan.
    await assertRejects(
      () =>
        engines[0].collections.transaction({
          namespace: "tenant",
          operationKey: "rollback",
          async execute({ collections }) {
            await collections.note.create({
              id: "rolled-back",
              content: "Same question",
            });
            await collections.note.update({
              id: "note-0",
              set: { marker: "loser" },
            });
            await engines[1].collections.withScope({ namespace: "tenant" }).note
              .update({
                id: "note-0",
                set: { marker: "winner" },
              });
          },
        }),
      Error,
      "changed while its mutation was prepared",
    );
    assertEquals(await notes.get({ id: "rolled-back" }), null);
    assertEquals((await notes.get({ id: "note-0" }))?.marker, "winner");

    // Standalone publishers use the same lock order as aggregate materialization.
    const prepared = await engines[0].content.preparer.prepare(
      "publisher race",
      {
        namespace: "tenant",
        idempotencyKey: "publisher-race",
      },
    );
    const candidate = prepared.assets[0];
    const [published, materialized] = await Promise.all([
      engines[0].content.assets.publish({
        namespace: "tenant",
        mediaType: candidate.mediaType,
        body: candidate.body,
        idempotencyKey: candidate.idempotencyKey,
      }),
      engines[1].content.assets.materialize({
        namespace: "tenant",
        content: prepared,
      }),
    ]);
    assertEquals(published.id, materialized[0].assetId);
    await assertRejects(
      () =>
        engines[1].content.assets.publish({
          namespace: "tenant",
          mediaType: candidate.mediaType,
          body: new TextEncoder().encode("different bytes"),
          idempotencyKey: candidate.idempotencyKey,
        }),
      Error,
      "reused with different content",
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite reconciles concurrent content across runtimes without replaying callbacks", () =>
  concurrentContent(":memory:"));
Deno.test({
  name:
    "PostgreSQL reconciles concurrent content across runtimes without replaying callbacks",
  ignore: !postgres,
  fn: () => concurrentContent(postgres!),
});
