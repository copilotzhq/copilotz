import { assertEquals, assertExists } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";
import { createStreamOutputDescriptor } from "./observation.ts";

Deno.test("stream admission uses captured command time with strict expiry and exact epoch authority", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `stream_clock_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let time = Date.parse("2000-01-01T00:00:00Z");
  const owner = await openDatabaseOwner(db, schema, {
    now: () => new Date(time),
  });
  await provisionOperationCatalog(db, schema);
  const run = createSchemaCommandRunner(db, schema),
    tables = createCoreTableNames(schema);
  const catalog = createOperationCatalog(db, schema),
    store = createEventStore({ session: db, schema });
  try {
    const appended = await store.append({
      namespace: "scope",
      type: "root",
      payload: {},
    }, ["consumer"]);
    const event = appended.event, delivery = appended.deliveries[0];
    await run(
      "test.index",
      {},
      (_input, { transaction }) =>
        catalog.indexEvent(transaction, {
          namespace: "scope",
          operationId: event.id,
          eventId: event.id,
          position: event.position,
          correlationId: event.correlationId,
          createdAt: event.createdAt,
          metadata: {},
        }),
    );
    for (const year of [2000, 2100]) {
      const deadline = Date.parse(`${year}-01-01T00:00:00Z`);
      for (const delta of [-1, 0, 1]) {
        time = deadline + delta;
        await run("test.lease", {}, async (_input, { transaction }) => {
          await transaction.query(
            `UPDATE ${tables.event_deliveries} SET status='leased', lease_owner='attempt', lease_expires_at=$2, owner_epoch=$3 WHERE id=$1`,
            [delivery.id, new Date(deadline).toISOString(), owner.epoch],
          );
        });
        const id = `lane-${year}-${delta}`;
        const opened = await catalog.openStream({
          namespace: "scope",
          operationId: event.id,
          semanticStreamId: id,
          bodyId: `body-${id}`,
          descriptor: createStreamOutputDescriptor({
            id,
            semanticId: id,
            mediaType: "text/plain",
            kind: "text",
            role: "output",
            metadata: {},
          }, { namespace: "scope" }),
          deliveryLease: { deliveryId: delivery.id, owner: "attempt" },
        });
        assertEquals(!!opened, delta === -1, `year=${year} delta=${delta}`);
      }
    }
    await run("test.localLease", {}, async (_input, { transaction }) => {
      await transaction.query(
        `UPDATE ${tables.event_deliveries} SET lease_expires_at=NULL WHERE id=$1`,
        [delivery.id],
      );
    });
    const local = (id: string) =>
      catalog.openStream({
        namespace: "scope",
        operationId: event.id,
        semanticStreamId: id,
        bodyId: `body-${id}`,
        descriptor: createStreamOutputDescriptor({
          id,
          semanticId: id,
          mediaType: "text/plain",
          kind: "text",
          role: "output",
          metadata: {},
        }, { namespace: "scope" }),
        deliveryLease: { deliveryId: delivery.id, owner: "attempt" },
      });
    assertExists(await local("local"));
    await run("test.staleEpoch", {}, async (_input, { transaction }) => {
      await transaction.query(
        `UPDATE ${tables.event_deliveries} SET owner_epoch=owner_epoch-1 WHERE id=$1`,
        [delivery.id],
      );
    });
    assertEquals(await local("stale"), undefined);
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
