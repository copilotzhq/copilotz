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

Deno.test("planned relations upsert, query, and retire with their endpoint", async () => {
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

    const created = await engine.collections.transaction({
      operationKey: "relation-a:create",
      namespace: "tenant-a",
      identity: {
        correlationId: "relation-contract",
        deduplicationId: "relation-a:create",
      },
      execute: ({ relations }) =>
        relations.upsert({
          id: "relation-a",
          type: "supports",
          source: { type: relationNodeCollection.name, id: "source-a" },
          target: { type: relationNodeCollection.name, id: "target-a" },
          metadata: { reason: "contract" },
        }),
    });
    assertEquals(created.value, { id: "relation-a" });
    const [relation] = await scoped.relation_contract_node.relations.list({
      id: "source-a",
      direction: "out",
      types: ["supports"],
    });
    assertExists(relation);
    assertEquals(relation.id, "relation-a");
    assertEquals(relation.target.id, "target-a");
    assertEquals(relation.metadata, { reason: "contract" });
    assertExists(
      (await engine.events.list({ namespace: "tenant-a" })).find((event) =>
        event.type === "relation.upserted"
      ),
    );

    await assertRejects(
      () =>
        engine.collections.transaction({
          operationKey: "missing-relation:create",
          namespace: "tenant-b",
          execute: ({ relations }) =>
            relations.upsert({
              type: "supports",
              source: {
                type: relationNodeCollection.name,
                id: "source-a",
              },
              target: {
                type: relationNodeCollection.name,
                id: "target-a",
              },
            }),
        }),
      Error,
      "was not found",
    );

    await scoped.relation_contract_node.delete({ id: "target-a" });
    assertEquals(
      await scoped.relation_contract_node.relations.list({
        id: "source-a",
        direction: "out",
        types: ["supports"],
      }),
      [],
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
