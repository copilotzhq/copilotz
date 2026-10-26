import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { restoreRetainedFixture } from "../../scripts/fixtures/retained-upgrade/load.ts";
import { prepareRetainedDataUpgrade } from "../actions/upgrade.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import { inspectEmbeddedContent } from "./migration.ts";
import { inspectOfflinePrefixes } from "./offline-prefixes.ts";
import { digestCatalogPrefix } from "./prefix-digest.ts";

Deno.test("batched native prefixes preserve the ordinary reader's bytes and inventory fingerprints", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `prefix_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await restoreRetainedFixture(db, schema);
    await prepareRetainedDataUpgrade(db, schema);
    const store = createDatabaseBodyStore({
      session: db,
      schema,
      provisioned: true,
    });
    const options = {
      session: db,
      schema,
      storeFor: () => store,
      streamBackend: { kind: "database", backendId: "database:default" },
    };
    assertEquals(
      await inspectEmbeddedContent({ ...options, nativeDatabase: db }),
      await inspectEmbeddedContent(options),
    );
    const requests = new Map([
      ["complete", { key: "retained-completed" }],
      ["prefix", { key: "retained-completed", length: 3 }],
      ["empty", { key: "retained-completed", length: 0 }],
      ["absent", { key: "absent" }],
    ]);
    const fast = await inspectOfflinePrefixes(db, schema, requests);
    assertEquals(fast.has("absent"), false);
    for (const [id, result] of fast) {
      assertEquals(
        result.head,
        await store.head({ bodyId: requests.get(id)!.key }),
      );
      assertEquals(
        result.digest,
        await digestCatalogPrefix(store, requests.get(id)!.key, result.length),
      );
    }
    await db.query(
      `DELETE FROM "${schema}".content_body_parts WHERE body_id='retained-completed'`,
    );
    await assertRejects(
      () => inspectOfflinePrefixes(db, schema, requests),
      Error,
      "unavailable",
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
