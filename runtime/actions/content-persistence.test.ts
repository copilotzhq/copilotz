import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCoreTableNames } from "../events/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { defineAction } from "./define.ts";

Deno.test("declared Action content persists references and retains Assets in PGlite", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "action_content_test";
  const namespace = "tenant";
  const bytes = new Uint8Array([0, 255, 4, 8]);
  let executions = 0;
  const action = defineAction({
    id: "test.consume-content",
    content: { input: ["content"] },
    execute(input: { content: { value: Uint8Array }[] }) {
      executions++;
      assert(input.content[0].value instanceof Uint8Array);
      assertEquals(input.content[0].value, bytes);
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
      assertEquals("value" in entry, false);
      assert(typeof entry.assetId === "string");
    }
    const owners = () =>
      db.query<{ type: string; target_node_id: string }>(
        `SELECT e.type,e.target_node_id FROM ${tables.edges} e JOIN ${tables.nodes} n ON n.id=e.source_node_id WHERE n.type='@copilotz/action-content'`,
      );
    const before = await owners();
    assertEquals(before.rows.length, 2);

    const assets = await db.query(
      `SELECT id FROM ${tables.nodes} WHERE type='asset'`,
    );
    assertEquals(assets.rows.length, 1);
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
