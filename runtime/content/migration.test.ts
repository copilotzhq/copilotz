import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("parallel inspection deduplicates claims and keeps disagreement checks", async () => {
  const bytes = new TextEncoder().encode("parallel"),
    digest = await digestContent(bytes);
  const store = createMemoryBodyStore({ backendId: "synthetic:parallel" });
  for (let i = 0; i < 20; i++) {
    await store.put({
      bodyId: `copy-${i}`,
      bytes,
      digest,
      mediaType: "text/plain",
    });
  }
  const nodes = Array.from(
    { length: 40 },
    (_, i) => ({
      namespace: "synthetic",
      id: `node-${i}`,
      data: {
        location: {
          kind: "memory",
          backendId: store.backendId,
          key: `copy-${i % 20}`,
        },
        byteLength: bytes.length,
        digest,
      },
    }),
  );
  const session: import("../events/session.ts").SqlSession = {
    query: (sql) =>
      Promise.resolve(
        {
          rows: sql.includes('"parallel"."nodes"')
            ? sql.includes("JOIN")
              ? nodes.map((n) => ({
                namespace: n.namespace,
                id: n.id,
                value: n.data,
              })).sort((a, b) => a.id.localeCompare(b.id))
              : nodes
            : sql.includes("to_regclass")
            ? [{ present: false }]
            : [],
        } as never,
      ),
    transaction: (run) => run(session),
  };
  let heads = 0, active = 0, peak = 0;
  const reader = {
    ...store,
    async head(input: Parameters<typeof store.head>[0]) {
      heads++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) =>
        setTimeout(resolve, Number(input.bodyId.split("-")[1]) % 3)
      );
      active--;
      return await store.head(input);
    },
  };
  const inspect = (concurrency: number) =>
    inspectEmbeddedContent({
      session,
      schema: "parallel",
      storeFor: () => reader,
      concurrency,
    });
  const sequential = await inspect(1);
  heads = 0;
  assertEquals(await inspect(7), sequential);
  assertEquals(heads, 20);
  assert(peak > 1 && peak <= 7);
  nodes[20].data.byteLength++;
  await assertRejects(() => inspect(7), Error, "references disagree");
  assertEquals(active, 0, "all workers settle before inspection rejects");
  await assertRejects(() => inspect(0), TypeError, "concurrency");
  await assertRejects(() => inspect(257), TypeError, "concurrency");
});

Deno.test("missing decisions refuse existing, completed, live, shared and unrelated content", async () => {
  const { unrecoverableDecisions } = await import("./unrecoverable.ts");
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = "missing_decision_refusals";
  try {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema),
      store = createMemoryBodyStore({ backendId: "synthetic:missing" });
    const loc = {
      kind: "memory",
      namespace: "synthetic",
      backendId: store.backendId,
      key: "missing",
    };
    const unrecoverable = await unrecoverableDecisions([{
      namespace: loc.namespace,
      backendId: loc.backendId,
      key: loc.key,
    }]);
    const inspect = () =>
      inspectEmbeddedContent({
        session: db,
        schema,
        storeFor: () => store,
        unrecoverable,
      });
    await assertRejects(inspect, Error, "not referenced");
    const set = (outcome: string, state = "terminal") =>
      db.query(
        `INSERT INTO ${tables.nodes}(namespace,id,type,name,data) VALUES('synthetic','a','asset','a',$1::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET data=EXCLUDED.data`,
        [JSON.stringify({ location: loc, outcome, state, byteLength: 10 })],
      );
    await set("completed");
    await assertRejects(inspect, Error, "completed or non-terminal");
    await set("failed", "open");
    await assertRejects(inspect, Error, "completed or non-terminal");
    await set("cancelled");
    assertEquals((await inspect()).inventory[0].unavailable, true);
    await db.query(
      `INSERT INTO ${tables.nodes}(namespace,id,type,name,data) VALUES('synthetic','b','asset','b',$1::jsonb)`,
      [JSON.stringify({ bodyId: loc.key, status: "completed" })],
    );
    await assertRejects(inspect, Error, "completed or non-terminal");
    await db.query(`DELETE FROM ${tables.nodes} WHERE id='b'`);
    const bytes = new Uint8Array([1]);
    await store.put({
      bodyId: loc.key,
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
    });
    await assertRejects(inspect, Error, "object exists");
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("streamed content fingerprint matches original payload serialization and locale ordering", async () => {
  const { retainedRows } = await import("./offline-rows.ts");
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = "content_fingerprint_parity";
  try {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema),
      store = createMemoryBodyStore();
    for (const id of ["z", "A", "a", "ä", "_", "10", "2"]) {
      await db.query(
        `INSERT INTO ${tables.nodes}(namespace,id,type,name,data) VALUES('synthetic',$1,'synthetic',$1,$2::jsonb)`,
        [id, JSON.stringify({ padding: "retained ".repeat(400), id })],
      );
    }
    const plan = await inspectEmbeddedContent({
      session: db,
      schema,
      storeFor: () => store,
    });
    const rows = [];
    for await (const row of retainedRows(db, schema)) rows.push(row);
    const legacy =
      (await db.query<{ namespace: string; id: string; data: unknown }>(
        `SELECT namespace,id,data FROM ${tables.nodes}`,
      )).rows.map((r) => ({
        namespace: r.namespace,
        id: r.id,
        value: r.data,
        kind: "node",
      })).sort((a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id)
      );
    assertEquals(rows, legacy);
    assertEquals(
      plan.fingerprint,
      await digestContent(
        new TextEncoder().encode(
          JSON.stringify({
            schema,
            inventory: plan.inventory,
            rows: legacy,
            streamRows: plan.streamRows,
          }),
        ),
      ),
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
