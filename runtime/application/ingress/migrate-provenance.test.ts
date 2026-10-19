import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../../events/schema.ts";
import { durableActionMetadata } from "../../actions/value.ts";
import { digestContent } from "../../content/digest.ts";
import { migrateIngressProvenance } from "../../../scripts/migrate-ingress-provenance.ts";

for (const corrupt of [false, true]) {
  Deno.test(`retained ingress migration verifies binding and is atomic (corrupt=${corrupt})`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    });
    const schema = `ingress_${crypto.randomUUID().replaceAll("-", "")}`;
    const t = createCoreTableNames(schema);
    try {
      await provisionCopilotzSchema(db, schema);
      await db.query(`ALTER TABLE ${t.events} DROP COLUMN owner_ingress`);
      await db.query(`UPDATE ${t.copilotz_schema_metadata} SET version=10`);
      const payload = { dataRef: { eventBodyId: "body" } },
        body = { input: "retained" };
      await db.query(
        `INSERT INTO ${t.events}(seq,id,schema_version,type,namespace,payload,metadata,correlation_id) VALUES(1,'event',10,'request','space',$1::jsonb,'{}','event')`,
        [JSON.stringify(payload)],
      );
      await db.query(
        `INSERT INTO ${t.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('space','body',1,$1::jsonb,'fixture')`,
        [JSON.stringify(body)],
      );
      const intent = {
        databaseSchema: schema,
        namespace: "space",
        eventId: "event",
        digest: corrupt ? "wrong" : await digestContent(
          new TextEncoder().encode(
            JSON.stringify(
              durableActionMetadata({
                type: "request",
                payload,
                metadata: {},
                body,
              }),
            ),
          ),
        ),
      };
      await db.query(
        `INSERT INTO ${t.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical','fixture','runtime','owner.ingress',$1::jsonb,'{"ingress":{"kind":"host"}}')`,
        [JSON.stringify(intent)],
      );
      if (corrupt) {
        await assertRejects(
          () => migrateIngressProvenance(db, schema),
          Error,
          "binding",
        );
        assertEquals(
          (await db.query(`SELECT version FROM ${t.copilotz_schema_metadata}`))
            .rows,
          [{ version: 10 }],
        );
        assertEquals(
          (await db.query(`SELECT key FROM ${t.owner_receipts}`)).rows.length,
          1,
        );
      } else {
        await migrateIngressProvenance(db, schema);
        assertEquals(
          (await db.query(`SELECT owner_ingress FROM ${t.events}`)).rows,
          [{ owner_ingress: { kind: "host" } }],
        );
        assertEquals(
          (await db.query(`SELECT key FROM ${t.owner_receipts}`)).rows.length,
          0,
        );
        await assertRejects(
          () => db.query(`UPDATE ${t.events} SET owner_ingress='{}'`),
          Error,
          "immutable",
        );
      }
    } finally {
      await db.close();
    }
  });
}
