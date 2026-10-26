import { assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { inspectAuthorityUpgrade } from "./upgrade.ts";
import { encodeEventBody } from "../events/body-store.ts";

Deno.test("authority candidate union preserves OR semantics and deduplicates active deliveries", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `inventory_${crypto.randomUUID().replaceAll("-", "")}`,
    q = `"${schema}"`;
  try {
    await db.query(`CREATE SCHEMA ${q}`);
    await db.query(
      `CREATE TABLE ${q}.events(namespace text,id text,metadata jsonb,payload jsonb,owner_ingress jsonb,type text,causation_id text)`,
    );
    await db.query(
      `CREATE TABLE ${q}.event_bodies(namespace text,event_body_id text,body jsonb,digest text,schema_version integer)`,
    );
    await db.query(
      `CREATE TABLE ${q}.event_deliveries(event_id text,status text,settlement_scope_id text)`,
    );
    await db.query(
      `CREATE TABLE ${q}.owner_receipts(key text,intent jsonb,result jsonb,owner text,domain text,kind text,principal text)`,
    );
    await db.query(
      `CREATE TABLE ${q}.copilotz_schema_metadata(singleton boolean)`,
    );
    await db.query(
      `CREATE TABLE ${q}.copilotz_operations(namespace text,root_event_id text,state text,operation_id text,parent_operation_id text)`,
    );
    await db.query(
      `CREATE TABLE ${q}.open_actions(namespace text,action_run_id text)`,
    );
    for (
      const [id, type, ingress, body] of [
        ["invoked", "copilotz.server.action.requested", { kind: "host" }, {
          status: "invoked",
          actionRunId: "run",
          actionId: "test",
          input: {},
        }],
        ["server", "copilotz.server.collection.mutation.requested", null, {
          input: {},
        }],
        ["classified", "ordinary", { kind: "host" }, { value: 1 }],
        ["active", "ordinary", null, { value: 2 }],
        ["json-null", "ordinary", null, { value: 3 }],
        ["settled", "ordinary", null, { value: 4 }],
      ] as const
    ) {
      const encoded = await encodeEventBody(body);
      await db.query(
        `INSERT INTO ${q}.event_bodies VALUES('space',$1,$2::jsonb,$3,1)`,
        [id, encoded.body, encoded.digest],
      );
      await db.query(
        `INSERT INTO ${q}.events VALUES('space',$1,'{"sourceEventId":"source"}',$2::jsonb,$3::jsonb,$4,NULL)`,
        [
          id,
          JSON.stringify({
            dataRef: {
              eventBodyId: id,
              schemaVersion: 1,
              mediaType: "application/json",
            },
          }),
          JSON.stringify(ingress),
          type,
        ],
      );
    }
    await db.query(
      `INSERT INTO ${q}.event_deliveries VALUES('invoked','pending',null),('active','pending',null),('active','leased',null),('active','retry_wait',null),('settled','succeeded',null)`,
    );
    const legacy = (await db.query<{ id: string }>(
      `SELECT e.id FROM ${q}.events e LEFT JOIN ${q}.event_bodies b ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId' WHERE COALESCE(b.body->'data',b.body)->>'status'='invoked' OR NULLIF(e.owner_ingress,'null'::jsonb) IS NOT NULL OR e.type IN ('copilotz.server.action.requested','copilotz.server.collection.mutation.requested') OR EXISTS(SELECT 1 FROM ${q}.event_deliveries d WHERE d.event_id=e.id AND d.status IN ('pending','leased','retry_wait')) ORDER BY e.id`,
    )).rows.map((row) => row.id);
    const inventory = await inspectAuthorityUpgrade(db, schema);
    assertEquals(legacy, ["active", "classified", "invoked", "server"]);
    assertEquals(inventory.invocations.map((row) => row.runId), ["run"]);
    assertEquals(inventory.events.map((row) => row.eventId), [
      "active",
    ]);
    assertEquals(inventory.history.events.map((row) => row.id), [
      "classified",
      "server",
    ]);
    assertEquals(inventory.history.counts, { invocations: 0, events: 2 });
    assertEquals(inventory.events.map((row) => row.unclassified), [
      true,
    ]);
  } finally {
    await db.query(`DROP SCHEMA ${q} CASCADE`);
    await db.close();
  }
});
