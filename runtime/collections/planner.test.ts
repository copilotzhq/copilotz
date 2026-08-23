import { assert, assertEquals } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type SqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import type {
  AssetMaterializationPlan,
  ContentSequence,
  DurableContentInput,
} from "../content/index.ts";
import {
  type CollectionContentAssets,
  createCollectionRuntime,
} from "./kernel.ts";
import { defineCollection } from "./definition.ts";

function canonicalContent(input: DurableContentInput): ContentSequence {
  return Array.isArray(input)
    ? input as ContentSequence
    : (input as { content: ContentSequence }).content;
}

Deno.test("collection mutations prepare once before SQL and only adopt inside commit", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const base = createSqlSession(db);
  const schema = "copilotz_collection_planner";
  for (const statement of createCoreSchemaStatements(schema)) {
    await base.query(statement);
  }

  let sqlOpen = false;
  let sqlTransactions = 0;
  const session: SqlSession = {
    query: base.query,
    transaction: (operation) =>
      base.transaction(async (transaction) => {
        assertEquals(sqlOpen, false);
        sqlOpen = true;
        sqlTransactions++;
        try {
          return await operation(transaction);
        } finally {
          sqlOpen = false;
        }
      }),
  };
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "collection-planner-test",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const phases: string[] = [];
  const assets: CollectionContentAssets = {
    async prepareMaterialization(input) {
      assertEquals(sqlOpen, false);
      phases.push("prepare");
      const plan: AssetMaterializationPlan = Object.freeze({
        namespace: input.namespace,
        content: canonicalContent(input.content),
        assets: Object.freeze([]),
        adoptions: Object.freeze([]),
      });
      return plan;
    },
    async adoptMaterialization(context, plan) {
      assert(sqlOpen);
      phases.push("adopt");
      for (const ref of plan.content) {
        await context.transaction.query(
          `INSERT INTO ${context.tables.nodes}
             (id, namespace, type, name, data)
           VALUES ($1, $2, 'asset', $3, $4::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            ref.assetId,
            plan.namespace,
            ref.mediaType,
            JSON.stringify({ state: "ready", mediaType: ref.mediaType }),
          ],
        );
      }
    },
  };
  let beforeCreateCalls = 0;
  let beforeUpdateCalls = 0;
  let commandCalls = 0;
  const documents = defineCollection({
    name: "planned_document",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        body: { type: "array" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["id", "namespace", "body", "createdAt", "updatedAt"],
    } as const,
    content: { fields: ["body"] },
    beforeCreate(record) {
      beforeCreateCalls++;
      return record;
    },
    beforeUpdate(record) {
      beforeUpdateCalls++;
      return record;
    },
    commands: {
      replace: {
        mutate({ input }) {
          commandCalls++;
          return {
            set: { body: (input as { body: ContentSequence }).body },
          };
        },
      },
    },
  });
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `planner-${++nextId}`,
    now: () => new Date("2026-08-22T12:00:00.000Z"),
  });
  const collection = runtime.bind(documents);
  const ref = (assetId: string): ContentSequence =>
    Object.freeze([Object.freeze({
      assetId,
      kind: "text" as const,
      role: "body",
      mediaType: "text/plain",
    })]);

  try {
    await collection.create({ id: "document-a", body: ref("asset-a") }, {
      namespace: "tenant-a",
    });
    await collection.update("document-a", { set: { body: ref("asset-b") } }, {
      namespace: "tenant-a",
    });
    await collection.mutate("document-a", "replace", {
      body: ref("asset-c"),
    }, { namespace: "tenant-a" });

    assertEquals(beforeCreateCalls, 1);
    assertEquals(beforeUpdateCalls, 1);
    assertEquals(commandCalls, 1);
    assertEquals(sqlTransactions, 3);
    assertEquals(phases, [
      "prepare",
      "adopt",
      "prepare",
      "adopt",
      "prepare",
      "adopt",
    ]);
  } finally {
    await executor.shutdown();
    await db.close();
  }
});
