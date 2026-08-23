import { assertEquals } from "@std/assert";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { detectLegacyGraphV1 } from "./profile.ts";
import { provisionLegacyGraphV1Fixture } from "./fixture.test.ts";

Deno.test("legacy-graph-v1 detection requires the exact released public profile", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    assertEquals(
      (await detectLegacyGraphV1(db.session)).kind,
      "legacy-graph-v1",
    );
    await db.session.query(
      "ALTER TABLE public.nodes ADD COLUMN unexpected text",
    );
    assertEquals((await detectLegacyGraphV1(db.session)).kind, "partial");
  } finally {
    await db.close();
  }
});

Deno.test("legacy profile distinguishes unmarked final and archive-cut state", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await db.session.query("CREATE TABLE public.nodes (id text)");
    await db.session.query("CREATE TABLE public.edges (id text)");
    await db.session.query("CREATE TABLE public.events (id text)");
    await db.session.query("CREATE TABLE public.event_bodies (id text)");
    await db.session.query("CREATE TABLE public.event_deliveries (id text)");
    await db.session.query(
      "CREATE TABLE public.copilotz_schema_metadata (singleton boolean)",
    );
    assertEquals((await detectLegacyGraphV1(db.session)).kind, "final");
    await db.session.query(
      "CREATE TABLE public.copilotz_v4_migration_state (singleton boolean)",
    );
    assertEquals((await detectLegacyGraphV1(db.session)).kind, "in-progress");
  } finally {
    await db.close();
  }
});
