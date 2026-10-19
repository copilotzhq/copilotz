import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import {
  migrateBodyStoreSchema,
  provisionBodyStoreSchema,
  validateBodyStoreSchema,
} from "./body-store-schema.ts";
import { digestContent } from "./digest.ts";
import { readBodyBytes } from "./body-store.ts";
const database = () =>
  createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
Deno.test("physical schema validates actual table presence even for provisioned adapters", async () => {
  const db = await database();
  const schema = `body_absence_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const store = createDatabaseBodyStore({
      session: db,
      schema,
      provisioned: true,
    });
    await assertRejects(() => store.head({ bodyId: "missing" }));
    const rows = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
      [schema],
    );
    assertEquals(rows.rows, []);
  } finally {
    await db.close();
  }
});
Deno.test("physical provisioning rejects partial tables without repairing them", async () => {
  const db = await database();
  const schema = `body_partial_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(
      `CREATE TABLE "${schema}".content_bodies(body_id TEXT PRIMARY KEY)`,
    );
    await assertRejects(() =>
      db.transaction((tx) => provisionBodyStoreSchema(tx, schema))
    );
    const rows = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name",
      [schema],
    );
    assertEquals(rows.rows, [{ table_name: "content_bodies" }]);
  } finally {
    await db.close();
  }
});
Deno.test("physical schema checks constraint integrity and rolls back incomplete DDL", async () => {
  const db = await database();
  const schema = `body_atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await assertRejects(() =>
      db.transaction(async (tx) => {
        await provisionBodyStoreSchema(tx, schema);
        throw new Error("fixture rollback");
      })
    );
    assertEquals(
      (await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=$1",
        [schema],
      )).rows,
      [],
    );
    await db.transaction((tx) => provisionBodyStoreSchema(tx, schema));
    await validateBodyStoreSchema(db, schema);
    await db.query(
      `ALTER TABLE "${schema}".content_body_parts DROP CONSTRAINT body_part_length`,
    );
    await assertRejects(() => validateBodyStoreSchema(db, schema));
    await db.query(
      `ALTER TABLE "${schema}".content_body_parts ADD CONSTRAINT body_part_length CHECK(octet_length(bytes)>=0)`,
    );
    await assertRejects(() => validateBodyStoreSchema(db, schema));
  } finally {
    await db.close();
  }
});
Deno.test("offline physical migration removes liveness columns, preserves bytes and is idempotent", async () => {
  const db = await database();
  const schema = `body_migration_${crypto.randomUUID().replaceAll("-", "")}`,
    bytes = new TextEncoder().encode("retained immutable bytes"),
    digest = await digestContent(bytes);
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(
      `CREATE TABLE "${schema}".content_bodies(body_id TEXT PRIMARY KEY,state TEXT NOT NULL,media_type TEXT NOT NULL,byte_length BIGINT NOT NULL,digest TEXT,writer_generation BIGINT,writer_token_hash TEXT,lease_expires_at TIMESTAMPTZ,protected_until TIMESTAMPTZ,maintenance_version BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),ready_at TIMESTAMPTZ)`,
    );
    await db.query(
      `CREATE TABLE "${schema}".content_body_parts(body_id TEXT NOT NULL REFERENCES "${schema}".content_bodies(body_id) ON DELETE CASCADE,start_offset BIGINT NOT NULL,append_id TEXT NOT NULL,bytes BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(body_id,start_offset),UNIQUE(body_id,append_id))`,
    );
    await db.query(
      `INSERT INTO "${schema}".content_bodies(body_id,state,media_type,byte_length,digest,maintenance_version) VALUES('retained','ready','text/plain',$1,$2,1)`,
      [bytes.length, digest],
    );
    await db.query(
      `INSERT INTO "${schema}".content_body_parts(body_id,start_offset,append_id,bytes) VALUES('retained',0,'put',$1)`,
      [bytes],
    );
    await assertRejects(() => validateBodyStoreSchema(db, schema));
    await db.query(`UPDATE "${schema}".content_bodies SET digest=$1`, [
      await digestContent(new Uint8Array()),
    ]);
    await assertRejects(() => migrateBodyStoreSchema(db, schema));
    assertEquals(
      (await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='content_bodies' AND column_name='version_token'",
        [schema],
      )).rows,
      [],
    );
    await db.query(`UPDATE "${schema}".content_bodies SET digest=$1`, [digest]);
    await migrateBodyStoreSchema(db, schema);
    await migrateBodyStoreSchema(db, schema);
    const store = createDatabaseBodyStore({
      session: db,
      schema,
      provisioned: true,
    });
    assertEquals(await readBodyBytes(store, { bodyId: "retained" }), bytes);
    const head = await store.head({ bodyId: "retained" });
    assertEquals(head?.state, "ready");
    assertEquals(
      (await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('lease_expires_at','protected_until','writer_token_hash')",
        [schema],
      )).rows,
      [],
    );
  } finally {
    await db.close();
  }
});

Deno.test("physical schema rejects volatile tables, domain aliases, identity and generated columns", async (t) => {
  const db = await database();
  try {
    for (const alteration of ["unlogged", "domain", "identity", "generated"]) {
      await t.step(alteration, async () => {
        const schema = `body_shape_${crypto.randomUUID().replaceAll("-", "")}`;
        await db.transaction((tx) => provisionBodyStoreSchema(tx, schema));
        if (alteration === "unlogged") {
          await db.query(
            `ALTER TABLE "${schema}".content_body_parts SET UNLOGGED`,
          );
        }
        if (alteration === "domain") {
          await db.query(`CREATE DOMAIN "${schema}".body_text AS TEXT`);
          await db.query(
            `ALTER TABLE "${schema}".content_bodies ALTER COLUMN media_type TYPE "${schema}".body_text`,
          );
        }
        if (alteration === "identity") {
          await db.query(
            `ALTER TABLE "${schema}".content_bodies ALTER COLUMN writer_generation ADD GENERATED ALWAYS AS IDENTITY`,
          );
        }
        if (alteration === "generated") {
          await db.query(
            `ALTER TABLE "${schema}".content_bodies ADD COLUMN generated_body_id TEXT GENERATED ALWAYS AS (body_id) STORED`,
          );
        }
        await assertRejects(() => validateBodyStoreSchema(db, schema));
      });
    }
  } finally {
    await db.close();
  }
});
