import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCoreTableNames } from "../events/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { defineAction } from "./define.ts";

Deno.test("inline Action content persists exact byte values without creating Assets", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "action_content_test";
  const namespace = "tenant";
  const bytes = new Uint8Array([0, 255, 4, 8]);
  const json = {
    nested: {
      assetId: "application-data",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      value: "original inline value",
    },
  };
  let executions = 0;
  const action = defineAction({
    id: "test.consume-content",
    content: { input: ["content"] },
    execute(input: { content: { value: unknown }[] }) {
      executions++;
      assert(input.content[0].value instanceof Uint8Array);
      assertEquals(input.content[0].value, bytes);
      assertEquals(input.content[1].value, json);
      return "accepted";
    },
  });
  const plugin = definePlugin({
    version: "1.0.0",
    id: "test.content-persistence",
    actions: { consume: action },
    processors: {
      start: defineProcessor({
        id: "test.content-persistence.start",
        on: [{ eventType: "test.content.requested" }],
        async handle(
          _event,
          context: import("../plugins/index.ts").ProcessorContext,
        ) {
          await (context.actions.consume as (
            input: unknown,
          ) => Promise<unknown>)({
            content: [{
              kind: "image",
              role: "body",
              mediaType: "image/png",
              value: bytes,
            }, {
              kind: "json",
              role: "body",
              mediaType: "application/json",
              value: json,
            }],
          });
        },
      }),
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace,
    databaseSchema: schema,
    plugins: [plugin],
  });
  try {
    const run = await app.send({
      type: "test.content.requested",
      deduplicationId: "start",
    });
    for await (const _ of run.outputs) { /* Drain observation. */ }
    await run.done;
    const second = await app.send({
      type: "test.content.requested",
      deduplicationId: "second",
    });
    for await (const _ of second.outputs) { /* Drain observation. */ }
    await second.done;
    assertEquals(executions, 2);
    const tables = createCoreTableNames(schema);
    const bodies = await db.query<
      {
        body: {
          actionId?: string;
          input?: { content: Record<string, unknown>[] };
        };
      }
    >(`SELECT body FROM ${tables.event_bodies}`);
    const lifecycle = bodies.rows.filter((row) =>
      row.body.actionId === action.id
    );
    assertEquals(lifecycle.length, 4);
    for (const row of lifecycle) {
      const entry = row.body.input!.content[0];
      assertEquals(entry.value, Array.from(bytes));
      assertEquals("assetId" in entry, false);
      assertEquals(row.body.input!.content[1].value, json);
    }
    const owners = () =>
      db.query<{ type: string; target_node_id: string }>(
        `SELECT e.type,e.target_node_id FROM ${tables.edges} e JOIN ${tables.nodes} n ON n.id=e.source_node_id WHERE n.type='@copilotz/action-content'`,
      );
    const before = await owners();
    assertEquals(before.rows.length, 0);

    const assets = await db.query(
      `SELECT id FROM ${tables.nodes} WHERE type='asset'`,
    );
    assertEquals(assets.rows.length, 0);
    const maintenance = await app.maintenance({
      namespace,
      assetOrphanAfterMs: 0,
      now: new Date("2100-01-01T00:00:00Z"),
    });
    assertEquals(maintenance.assets.orphanedBodiesDeleted, 0);
  } finally {
    await app.shutdown();
    await db.close();
  }
});

async function messageContentLifetime(url: string) {
  const { defineCollection } = await import("../collections/index.ts");
  const { messageCollection } = await import(
    "../../plugins/core/collections/message/index.ts"
  );
  const { assertRejects } = await import("@std/assert");
  const db = await createTestDatabase({ url });
  const schema = `pointer_lifetime_${crypto.randomUUID().replaceAll("-", "")}`;
  const namespace = "test";
  let content: import("../content/types.ts").ContentRef[] = [];
  let executions = 0;
  const consume = defineAction({
    id: "test.consume",
    content: { input: ["content"] },
    execute: () => {
      executions++;
      return "ok";
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace,
    databaseSchema: schema,
    plugins: [definePlugin({
      id: "test.message-content",
      version: "1.0.0",
      actions: { consume },
      collections: {
        message: messageCollection,
        thread: defineCollection({
          name: "thread",
          schema: { type: "object", properties: { id: { type: "string" } } },
        }),
        participant: defineCollection({
          name: "participant",
          schema: { type: "object", properties: { id: { type: "string" } } },
        }),
      },
      processors: {
        start: defineProcessor({
          id: "test.consume.start",
          on: [{ eventType: "test.consume.requested" }],
          async handle(
            _event,
            context: import("../plugins/index.ts").ProcessorContext,
          ) {
            await (context.actions.consume as (
              input: unknown,
            ) => Promise<unknown>)({ content });
          },
        }),
      },
    })],
  });
  const engine = app.engine;
  try {
    const collections = engine.collections.withScope({ namespace });
    await collections.thread.create({ id: "thread" });
    await collections.participant.create({ id: "sender" });
    const message = await collections.message.create({
      id: "message",
      threadId: "thread",
      senderId: "sender",
      content: "owned text",
    });
    content = message.content as import("../content/types.ts").ContentRef[];
    const assetId = content[0].assetId;
    const run = await app.send({
      type: "test.consume.requested",
      deduplicationId: "consume",
    });
    for await (const _ of run.outputs) { /* Drain observation. */ }
    await run.done;
    assertEquals(executions, 1);
    const refused = await assertRejects(() =>
      engine.content.assets.markDeleted(namespace, assetId)
    );
    assertEquals((refused as { code?: string }).code, "asset_conflict");
    const tables = createCoreTableNames(schema);
    const owners = await db.query<{ source_node_id: string }>(
      `SELECT source_node_id FROM ${tables.edges} WHERE target_node_id=$1 AND type='has_asset'`,
      [assetId],
    );
    assertEquals(owners.rows, [{ source_node_id: "message" }]);
    await collections.message.delete({ id: "message" });
    await engine.content.assets.markDeleted(namespace, assetId);
    // Owner commands use their own time; expire catalog protection in the fixture.
    await db.query(
      `UPDATE ${tables.content_logical_bodies} SET protected_until = NOW() - INTERVAL '1 second'`,
    );
    await db.query(
      `UPDATE ${tables.pending_content} SET expires_at = NOW() - INTERVAL '1 second'`,
    );
    const result = await engine.maintenance({
      namespace,
      assetOrphanAfterMs: 0,
      now: new Date("2100-01-01"),
    });
    assert(result.assets.orphanedBodiesDeleted > 0);
    const bodies = await db.query(
      `SELECT body FROM ${tables.event_bodies} WHERE body->>'actionId'='test.consume'`,
    );
    assertEquals(
      bodies.rows.length,
      2,
      "execution history survives content collection",
    );
  } finally {
    await app.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("message deletion releases content despite captured Action pointers; domain ownership refuses deletion", () =>
  messageContentLifetime(":memory:"));
Deno.test({
  name:
    "PostgreSQL message deletion releases captured content while domain ownership protects it",
  ignore: !Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => messageContentLifetime(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!),
});
