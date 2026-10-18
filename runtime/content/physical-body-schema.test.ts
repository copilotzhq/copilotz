import { provisionOperationCatalog } from "../streams/catalog.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import {
  provisionPhysicalBodySchema,
  refuseOwnerPhysicalSchema,
  validatePhysicalBodySchema,
} from "./physical-body-schema.ts";

Deno.test("private physical schema provisions atomically and reopens without repair", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await provisionPhysicalBodySchema(db, "physical");
    await validatePhysicalBodySchema(db, "physical");
    await assertRejects(() => refuseOwnerPhysicalSchema(db, "physical"));
    const before = await db.query(
      "SELECT count(*) AS n FROM physical.content_bodies",
    );
    for (const provisioned of [false, true]) {
      const legacy = createDatabaseBodyStore({
        session: db,
        schema: "physical",
        provisioned,
      });
      await assertRejects(() =>
        legacy.reserve({ bodyId: "old", mediaType: "text/plain" })
      );
      await assertRejects(() =>
        legacy.maintenance.list({ states: ["open"], idleForMs: 0, limit: 10 })
      );
    }
    assertEquals(
      await db.query("SELECT count(*) AS n FROM physical.content_bodies"),
      before,
    );
  } finally {
    await db.close();
  }
});

Deno.test("private physical schema rejects legacy and partial layouts without adding tables", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const legacy = createDatabaseBodyStore({ session: db, schema: "legacy" });
    await legacy.reserve({ bodyId: "old", mediaType: "text/plain" });
    await assertRejects(() => provisionPhysicalBodySchema(db, "legacy"));
    await db.query("CREATE SCHEMA partial");
    await db.query(
      "CREATE TABLE partial.content_bodies(body_id TEXT PRIMARY KEY)",
    );
    await assertRejects(() => provisionPhysicalBodySchema(db, "partial"));
    assertEquals(
      (await db.query(
        "SELECT to_regclass('partial.content_body_parts') AS name",
      )).rows[0].name,
      null,
    );
  } finally {
    await db.close();
  }
});

Deno.test("private physical schema rejects weakened retained checks", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await db.query(
      "ALTER TABLE physical.content_bodies DROP CONSTRAINT physical_format",
    );
    await assertRejects(() => provisionPhysicalBodySchema(db, "physical"));
    await assertRejects(() => validatePhysicalBodySchema(db, "physical"));
    // Reopening never repairs a dropped constraint.
    assertEquals(
      (await db.query(
        "SELECT count(*)::int AS n FROM pg_constraint WHERE conname='physical_format'",
      )).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});

Deno.test("legacy provisioned hint cannot cache an absent physical format", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const legacy = createDatabaseBodyStore({
      session: db,
      schema: "later",
      provisioned: true,
    });
    await assertRejects(() =>
      legacy.reserve({ bodyId: "old", mediaType: "text/plain" })
    );
    await provisionPhysicalBodySchema(db, "later");
    await assertRejects(() =>
      legacy.reserve({ bodyId: "old", mediaType: "text/plain" })
    );
    assertEquals(
      (await db.query("SELECT count(*)::int AS n FROM later.content_bodies"))
        .rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});

Deno.test("private physical and legacy core provisioning cannot adopt each other's schema", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await assertRejects(() => provisionCopilotzSchema(db, "physical"));
    await assertRejects(() => provisionOperationCatalog(db, "physical"));
    assertEquals(
      (await db.query("SELECT to_regclass('physical.events') AS name")).rows[0]
        .name,
      null,
    );
    await provisionCopilotzSchema(db, "legacy");
    await assertRejects(() => provisionPhysicalBodySchema(db, "legacy"));
    assertEquals(
      (await db.query("SELECT to_regclass('legacy.content_bodies') AS name"))
        .rows[0].name,
      null,
    );
  } finally {
    await db.close();
  }
});

Deno.test("private physical schema rejects identity and generated retained columns", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await db.query(
      "ALTER TABLE physical.content_bodies ALTER COLUMN writer_generation ADD GENERATED ALWAYS AS IDENTITY",
    );
    await assertRejects(() => validatePhysicalBodySchema(db, "physical"));
    await assertRejects(() => provisionPhysicalBodySchema(db, "physical"));
    await db.query(
      "ALTER TABLE physical.content_bodies ALTER COLUMN writer_generation DROP IDENTITY",
    );
    await validatePhysicalBodySchema(db, "physical");
    await db.query(
      "ALTER TABLE physical.content_bodies DROP COLUMN version_token",
    );
    await db.query(
      "ALTER TABLE physical.content_bodies ADD COLUMN version_token TEXT GENERATED ALWAYS AS (body_id) STORED NOT NULL",
    );
    await assertRejects(() => validatePhysicalBodySchema(db, "physical"));
    await assertRejects(() => provisionPhysicalBodySchema(db, "physical"));
  } finally {
    await db.close();
  }
});

Deno.test("private physical schema rejects unlogged retained tables", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await db.query("ALTER TABLE physical.content_body_parts SET UNLOGGED");
    await assertRejects(() => validatePhysicalBodySchema(db, "physical"));
    await assertRejects(() => provisionPhysicalBodySchema(db, "physical"));
  } finally {
    await db.close();
  }
});

Deno.test("private physical schema rejects retained domain types", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionPhysicalBodySchema(db, "physical");
    await db.query(
      "CREATE DOMAIN physical.only_json AS TEXT CHECK (VALUE='application/json')",
    );
    await db.query(
      "ALTER TABLE physical.content_bodies ALTER COLUMN media_type TYPE physical.only_json",
    );
    await assertRejects(() => validatePhysicalBodySchema(db, "physical"));
    await assertRejects(() => provisionPhysicalBodySchema(db, "physical"));
  } finally {
    await db.close();
  }
});
