import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createMemoryBodyStore } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { inspectEmbeddedContent, migrateEmbeddedContent } from "./migration.ts";
import { createContentCatalog, openLogicalBody } from "./catalog.ts";
import { encodeEventBody } from "../events/body-store.ts";
Deno.test("offline embedded-location migration preserves assets, protected pointers and event integrity", async () => {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = "content_migration_fixture",
    namespace = "namespace-a";
  try {
    if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema),
      store = createMemoryBodyStore({ backendId: "memory:migration" }),
      bytes = new TextEncoder().encode("retained"),
      digest = await digestContent(bytes);
    await store.put({
      bodyId: "old/physical-key",
      bytes,
      mediaType: "text/plain",
      digest,
    });
    const data = {
      state: "ready",
      bodyId: "old/physical-key",
      location: {
        kind: "memory",
        backendId: store.backendId,
        key: "old/physical-key",
      },
      byteLength: bytes.length,
      digest,
      mediaType: "text/plain",
    };
    await db.query(
      `INSERT INTO ${tables.nodes}(namespace,id,type,name,data,created_at,updated_at) VALUES($1,'asset-a','asset','text',$2::jsonb,NOW(),NOW())`,
      [namespace, JSON.stringify(data)],
    );
    const original = {
      asset: { id: "asset-a", namespace, ...data },
      bodyId: "old/physical-key",
    };
    const encoded = await encodeEventBody(original);
    await db.query(
      `INSERT INTO ${tables.event_bodies}(namespace,event_body_id,schema_version,body,digest,created_at) VALUES($1,'event-a',1,$2::jsonb,$3,NOW())`,
      [namespace, encoded.body, encoded.digest],
    );
    const plan = await inspectEmbeddedContent({
      session: db,
      schema,
      storeFor: () => store,
    });
    assertEquals(plan.inventory.length, 1);
    await assertRejects(() =>
      migrateEmbeddedContent({
        session: db,
        plan,
        drained: true,
        reviewedFingerprint: "wrong",
      })
    );
    assertEquals(
      await migrateEmbeddedContent({
        session: db,
        plan,
        drained: true,
        reviewedFingerprint: plan.fingerprint,
      }),
      { bodies: 1, documents: 2, streams: 0 },
    );
    const migrated = (await db.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${tables.nodes} WHERE id='asset-a'`,
    )).rows[0].data;
    assertEquals("location" in migrated, false);
    assertEquals(migrated.bodyId, plan.inventory[0].bodyId);
    assertEquals(
      await new Response(
        await openLogicalBody(
          createContentCatalog(db, schema),
          String(migrated.bodyId),
          () => store,
        ),
      ).text(),
      "retained",
    );
    const event = (await db.query<{ body: unknown; digest: string }>(
      `SELECT body,digest FROM ${tables.event_bodies}`,
    )).rows[0];
    assertEquals(event.digest, (await encodeEventBody(event.body)).digest);
  } finally {
    await db.close();
  }
});
Deno.test("offline migration rejects a changed reviewed source atomically", async () => {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = "content_migration_rollback";
  try {
    if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema),
      store = createMemoryBodyStore();
    const bytes = new Uint8Array([1]), digest = await digestContent(bytes);
    await store.put({
      bodyId: "old-key",
      bytes,
      mediaType: "application/octet-stream",
      digest,
    });
    const data = {
      bodyId: "old-key",
      location: { kind: "memory", backendId: store.backendId, key: "old-key" },
      byteLength: 1,
      digest,
    };
    await db.query(
      `INSERT INTO ${tables.nodes}(namespace,id,type,name,data,created_at,updated_at) VALUES('namespace-a','a','asset','a',$1::jsonb,NOW(),NOW())`,
      [JSON.stringify(data)],
    );
    const plan = await inspectEmbeddedContent({
      session: db,
      schema,
      storeFor: () => store,
    });
    await db.query(
      `UPDATE ${tables.nodes} SET data=data||'{"changed":true}'::jsonb`,
    );
    await assertRejects(() =>
      migrateEmbeddedContent({
        session: db,
        plan,
        drained: true,
        reviewedFingerprint: plan.fingerprint,
      })
    );
    assertEquals(
      (await db.query(`SELECT 1 FROM ${tables.content_logical_bodies}`)).rows
        .length,
      0,
    );
  } finally {
    await db.close();
  }
});
Deno.test("offline object import mapping keeps original identity while selecting the verified replacement", async () => {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = "content_import_mapping";
  try {
    if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema),
      store = createMemoryBodyStore({ backendId: "object:imported" }),
      bytes = new TextEncoder().encode("retained"),
      digest = await digestContent(bytes);
    await store.put({
      bodyId: "new-physical",
      bytes,
      mediaType: "text/plain",
      digest,
    });
    const data = {
      bodyId: "old-raw",
      location: { kind: "object", backendId: store.backendId, key: "old-raw" },
      byteLength: bytes.length,
      digest,
    };
    await db.query(
      `INSERT INTO ${tables.nodes}(namespace,id,type,name,data,created_at,updated_at) VALUES('namespace-a','a','asset','a',$1::jsonb,NOW(),NOW())`,
      [JSON.stringify(data)],
    );
    const plan = await inspectEmbeddedContent({
      session: db,
      schema,
      storeFor: () => store,
      copyMappings: [{
        namespace: "namespace-a",
        backendId: store.backendId,
        sourceBodyId: "old-raw",
        targetBodyId: "new-physical",
      }],
    });
    assertEquals(plan.inventory[0].key, "new-physical");
    assertEquals(plan.inventory[0].sourceKey, "old-raw");
    await migrateEmbeddedContent({
      session: db,
      plan,
      drained: true,
      reviewedFingerprint: plan.fingerprint,
    });
    const migrated = (await db.query<{ data: { bodyId: string } }>(
      `SELECT data FROM ${tables.nodes}`,
    )).rows[0].data;
    assertEquals(
      await new Response(
        await openLogicalBody(
          createContentCatalog(db, schema),
          migrated.bodyId,
          () => store,
        ),
      ).text(),
      "retained",
    );
  } finally {
    await db.close();
  }
});
