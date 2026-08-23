import { assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineCollection } from "../collections/index.ts";

const relationNodeCollection = defineCollection({
  name: "relation_contract_node",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
    required: ["id", "name"],
  } as const,
});

Deno.test("typed relations create, query, and delete direct graph edges", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.typed-relations",
      version: "1.0.0",
      collections: { relationNode: relationNodeCollection },
    })],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "typed_relation_contract",
  });
  try {
    const scoped = engine.collections.withScope({ namespace: "tenant-a" });
    await scoped.relation_contract_node.create({
      id: "source-a",
      name: "Source",
    });
    await scoped.relation_contract_node.create({
      id: "target-a",
      name: "Target",
    });

    const created = await engine.relations.create({
      namespace: "tenant-a",
      id: "relation-a",
      type: "supports",
      source: { type: relationNodeCollection.name, id: "source-a" },
      target: { type: relationNodeCollection.name, id: "target-a" },
      metadata: { reason: "contract" },
      identity: {
        correlationId: "relation-contract",
        deduplicationId: "relation-a:create",
      },
    });
    assertEquals(created.event.type, "relation.created");
    assertEquals(created.event.payload, { relationId: "relation-a" });
    assertExists(created.value);
    assertEquals(created.value.metadata, { reason: "contract" });
    assertEquals(
      await engine.relations.list({
        namespace: "tenant-a",
        nodeId: "source-a",
        direction: "out",
        types: ["supports"],
      }),
      [created.value],
    );
    assertEquals(
      (await engine.relations.get("tenant-a", "relation-a"))?.target.id,
      "target-a",
    );

    await assertRejects(
      () =>
        engine.relations.create({
          namespace: "tenant-b",
          type: "supports",
          source: { type: relationNodeCollection.name, id: "source-a" },
          target: { type: relationNodeCollection.name, id: "target-a" },
        }),
      Error,
      "was not found",
    );

    const deleted = await engine.relations.delete({
      namespace: "tenant-a",
      id: "relation-a",
      identity: { deduplicationId: "relation-a:delete" },
    });
    assertEquals(deleted.event.type, "relation.deleted");
    assertEquals(await engine.relations.get("tenant-a", "relation-a"), null);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
