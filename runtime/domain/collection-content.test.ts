import { assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineCollection } from "./index.ts";

const contentOwnerCollection = defineCollection({
  name: "contract_content_owner",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      body: { type: "array" },
      reject: { type: "boolean" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "body"],
  } as const,
  content: { fields: ["body"] },
});

Deno.test("custom collection content materializes and links atomically", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.collection-content",
        version: "1.0.0",
        provides: { collections: [contentOwnerCollection.name] },
      },
      resources: { collections: [contentOwnerCollection] },
    })],
  });
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "collection_content_contract",
    createId: () => `generated-${++nextId}`,
    validateCollection({ definition, record }) {
      if (
        definition.name === contentOwnerCollection.name &&
        record.reject === true
      ) {
        throw new Error("synthetic validation failure");
      }
    },
  });
  try {
    const scoped = engine.collections.withScope({ namespace: "tenant-a" });
    const rejected = await engine.content.preparer.prepare("rolled back", {
      namespace: "tenant-a",
      idempotencyKey: "rejected-body",
    });
    const rejectedAssetId = rejected.content[0].assetId;
    await assertRejects(
      () =>
        scoped.contract_content_owner.create({
          id: "rejected-owner",
          body: rejected,
          reject: true,
        }),
      Error,
      "synthetic validation failure",
    );
    assertEquals(
      await engine.content.assets.get("tenant-a", rejectedAssetId),
      null,
    );

    const first = await engine.content.preparer.prepare("first body", {
      namespace: "tenant-a",
      idempotencyKey: "first-body",
    });
    const created = await scoped.contract_content_owner.create({
      id: "content-owner",
      body: first,
      reject: false,
    });
    assertEquals(created.body, first.content);
    assertEquals(
      new TextDecoder().decode(
        (await engine.content.assets.read(
          "tenant-a",
          first.content[0].assetId,
        )).bytes,
      ),
      "first body",
    );

    const second = await engine.content.preparer.prepare("second body", {
      namespace: "tenant-a",
      idempotencyKey: "second-body",
    });
    const updated = await scoped.contract_content_owner.update({
      id: "content-owner",
      set: { body: second },
    });
    assertEquals(updated.body, second.content);

    const links = await db.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT source_node_id, target_node_id
       FROM "collection_content_contract"."edges"
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      ["tenant-a", "content-owner"],
    );
    assertEquals(links.rows, [{
      source_node_id: "content-owner",
      target_node_id: second.content[0].assetId,
    }]);
    assertExists(
      await engine.content.assets.get("tenant-a", first.content[0].assetId),
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
