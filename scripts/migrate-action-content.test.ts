import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import {
  createCoreTableNames,
  createEventStore,
  provisionCopilotzSchema,
} from "../runtime/events/index.ts";
import { migrateActionContent } from "./migrate-action-content.ts";

async function fixture(url = ":memory:") {
  const db = await createTestDatabase({ url });
  const schema = `content_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const tables = createCoreTableNames(schema);
  await provisionCopilotzSchema(db, schema);
  const node = (
    id: string,
    type: string,
    data: unknown = {},
    namespace = "test",
  ) =>
    db.query(
      `INSERT INTO ${tables.nodes} (id,namespace,type,name,data) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        id,
        namespace,
        type,
        type === "@copilotz/action-content" ? "test.consume" : type,
        JSON.stringify(data),
      ],
    );
  const edge = (
    id: string,
    source: string,
    target: string,
    type = "has_asset",
    namespace = "test",
  ) =>
    db.query(
      `INSERT INTO ${tables.edges} (id,namespace,source_node_id,target_node_id,type) VALUES ($1,$2,$3,$4,$5)`,
      [id, namespace, source, target, type],
    );
  const store = createEventStore({ session: db, schema });
  await store.commitMutation({
    draft: {
      namespace: "test",
      type: "test.history",
      payload: {},
      deduplicationId: "history",
    },
    consumers: [],
  });
  const snapshot = async () => ({
    nodes: (await db.query(`SELECT * FROM ${tables.nodes} ORDER BY id`)).rows,
    edges: (await db.query(`SELECT * FROM ${tables.edges} ORDER BY id`)).rows,
    events: (await db.query(`SELECT * FROM ${tables.events} ORDER BY id`)).rows,
  });
  return {
    db,
    schema,
    tables,
    node,
    edge,
    snapshot,
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

async function migrationScenario(url?: string) {
  const f = await fixture(url);
  try {
    await f.node("message", "message", { content: [{ assetId: "owned" }] });
    await f.node("stage", "tool_plan_stage_result", {
      content: [{ assetId: "tool" }],
    });
    await f.node("memory", "long_term_memory", {
      content: [{ assetId: "snapshot" }],
    });
    await f.node("config", "agent_configuration");
    await f.node("foreign", "message", {}, "other");
    for (const id of ["owned", "tool", "snapshot", "orphan", "assigned"]) {
      await f.node(id, "asset", {
        state: "ready",
        origin: id === "snapshot"
          ? { type: "long_term_memory", id: "memory" }
          : { type: "namespace", id: "test" },
      });
    }
    await f.node("receipt", "@copilotz/action-content", {
      assetIds: ["owned", "tool", "snapshot", "orphan", "assigned"],
    });
    await f.edge("domain", "message", "owned");
    for (const id of ["owned", "tool", "snapshot", "orphan", "assigned"]) {
      await f.edge(`execution-${id}`, "receipt", id);
    }
    await f.edge("other-execution-relation", "message", "receipt", "related");
    const before = await f.snapshot();
    const report = await migrateActionContent(f.db, f.schema);
    assertEquals(report.executionOwners, 1);
    assertEquals(report.executionEdges, 6);
    assertEquals(report.byProducer, {
      message: 1,
      tool_plan_stage_result: 1,
      long_term_memory: 1,
      unowned: 2,
    });
    assertEquals(report.assets.map((asset) => asset.classification).sort(), [
      "owned",
      "producer",
      "producer",
      "unowned",
      "unowned",
    ]);
    assertEquals(
      report.assets.every((asset) => asset.consumers[0] === "test.consume"),
      true,
    );
    assertEquals(report.removedNodes, 0);
    assertEquals(await f.snapshot(), before, "dry run changes nothing");
    await assertRejects(
      () => migrateActionContent(f.db, f.schema, { apply: true }),
      Error,
      "Explicit owner",
    );
    assertEquals(
      await f.snapshot(),
      before,
      "partial adoption rolls back on an unresolved asset",
    );
    await assertRejects(
      () =>
        migrateActionContent(f.db, f.schema, {
          apply: true,
          decisions: [
            { namespace: "test", assetId: "orphan", ownerId: null },
            { namespace: "test", assetId: "assigned", ownerId: "foreign" },
          ],
        }),
      Error,
      "Domain producer not found",
    );
    assertEquals(await f.snapshot(), before);
    const applied = await migrateActionContent(f.db, f.schema, {
      apply: true,
      decisions: [
        { namespace: "test", assetId: "orphan", ownerId: null },
        { namespace: "test", assetId: "assigned", ownerId: "config" },
      ],
    });
    assertEquals(applied.removedNodes, 1);
    assertEquals(applied.removedEdges, 6);
    assertEquals(applied.assignedOwners, 3);
    const after = await f.snapshot();
    assertEquals(after.events, before.events);
    assertEquals(
      after.nodes,
      before.nodes.filter((node) => node.id !== "receipt"),
    );
    assertEquals(
      after.edges.map((edge) => [edge.source_node_id, edge.target_node_id])
        .sort(),
      [["config", "assigned"], ["memory", "snapshot"], ["message", "owned"], [
        "stage",
        "tool",
      ]],
    );
    assertEquals(
      (await migrateActionContent(f.db, f.schema, { apply: true }))
        .removedNodes,
      0,
    );
    assertEquals(await f.snapshot(), after, "repeated migration is a no-op");
  } finally {
    await f.close();
  }
}

Deno.test("offline content migration classifies producers, preserves history and atomically removes execution owners", () =>
  migrationScenario());
Deno.test({
  name: "PostgreSQL offline content migration on isolated fixtures",
  ignore: !Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => migrationScenario(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")),
});

Deno.test("migration refuses ambiguous or broken ownership and active execution", async () => {
  const f = await fixture();
  try {
    await f.node("a", "message", { content: [{ assetId: "asset" }] });
    await f.node("b", "message", { content: [{ assetId: "asset" }] });
    await f.node("asset", "asset", { state: "ready" });
    await f.node("receipt", "@copilotz/action-content", {
      assetIds: ["asset", "missing"],
    });
    const report = await migrateActionContent(f.db, f.schema);
    assertEquals(report.assets.map((asset) => asset.classification).sort(), [
      "ambiguous",
      "missing",
    ]);
    await assertRejects(
      () => migrateActionContent(f.db, f.schema, { apply: true }),
      Error,
      "ambiguous",
    );
    await f.db.query(`DELETE FROM ${f.tables.nodes} WHERE id='b'`);
    await assertRejects(
      () => migrateActionContent(f.db, f.schema, { apply: true }),
      Error,
      "missing",
    );
    const store = createEventStore({ session: f.db, schema: f.schema });
    await store.commitMutation({
      draft: { namespace: "test", type: "test.pending", payload: {} },
      consumers: [{ consumerId: "test.consumer", settlement: "inherit" }],
    });
    await assertRejects(
      () => migrateActionContent(f.db, f.schema, { apply: true }),
      Error,
      "Drain",
    );
  } finally {
    await f.close();
  }
});
