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

Deno.test("grouped cancellation and both stream terminal paths use each command's captured time", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `catalog_clock_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let time = Date.parse("2000-01-01T00:00:00Z");
  const owner = await openDatabaseOwner(db, schema, {
    now: () => new Date(time),
  });
  await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  const run = createSchemaCommandRunner(db, schema);
  const { recordTestContentTerminal } = await import(
    "../testing/content-catalog.ts"
  );
  try {
    for (const id of ["first", "second"]) {
      await run(
        "test.index",
        {},
        (_, { transaction }) =>
          catalog.indexEvent(transaction, {
            namespace: "scope",
            operationId: id,
            eventId: id,
            position: "1",
            correlationId: id,
            createdAt: new Date(time).toISOString(),
            metadata: {},
          }),
      );
      for (const streamId of ["seal", "unavailable"]) {
        assertExists(
          await catalog.openStream({
            namespace: "scope",
            operationId: id,
            semanticStreamId: `${id}-${streamId}`,
            bodyId: `${id}-${streamId}`,
            descriptor: createStreamOutputDescriptor({
              id: `${id}-${streamId}`,
              semanticId: `${id}-${streamId}`,
              mediaType: "text/plain",
              kind: "text",
              role: "output",
              metadata: {},
            }, { namespace: "scope" }),
          }),
        );
      }
      await recordTestContentTerminal(db, schema, "scope", {
        bodyId: `${id}-seal`,
        byteLength: 0,
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "text/plain",
      });
    }
    const transactions: unknown[] = [];
    const times: string[] = [];
    const transition = owner.register("test.transitions", {
      authorize() {},
      async execute(id: string, { transaction, commandTime }) {
        times.push(commandTime);
        transactions.push(
          (await transaction.query("SELECT txid_current() AS id")).rows[0].id,
        );
        // Complete one stream before cancellation; purge the other afterwards.
        assertEquals(
          await catalog.sealStream({
            namespace: "scope",
            operationId: id,
            streamId: `${id}-seal`,
            body: {
              bodyId: `${id}-seal`,
              state: "ready",
              byteLength: 0,
              mediaType: "text/plain",
              digest: `sha256:${"a".repeat(64)}`,
              maintenanceVersion: 1,
              versionToken: "test-version",
            },
          }),
          true,
        );
        await catalog.requestCancellation(
          transaction,
          "scope",
          id,
          "cancelled",
        );
        await catalog.markStreamUnavailable({
          namespace: "scope",
          operationId: id,
          streamId: `${id}-unavailable`,
          outcome: "cancelled",
          reason: "cancelled",
          availabilityReason: "missing",
        });
        if (id === "first") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          time += 10_000;
        }
      },
    });
    const caller = { principal: "runtime", epoch: owner.epoch! };
    await Promise.all([
      transition(caller, { input: "first" }),
      transition(caller, { input: "second" }),
    ]);
    assertEquals(transactions[0], transactions[1]);
    assertEquals(times, [
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:10.000Z",
    ]);
    for (const [index, id] of ["first", "second"].entries()) {
      const operation = (await db.query<{ cancellation_requested_at: string }>(
        `SELECT cancellation_requested_at FROM "${schema}".copilotz_operations WHERE operation_id=$1`,
        [id],
      )).rows[0];
      assertEquals(
        new Date(operation.cancellation_requested_at).toISOString(),
        times[index],
      );
      const streams =
        (await db.query<{ terminal_at: string; updated_at: string }>(
          `SELECT terminal_at,updated_at FROM "${schema}".copilotz_operation_streams WHERE operation_id=$1`,
          [id],
        )).rows;
      assertEquals(streams.length, 2);
      for (const stream of streams) {
        assertEquals(new Date(stream.terminal_at).toISOString(), times[index]);
        assertEquals(new Date(stream.updated_at).toISOString(), times[index]);
      }
    }
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
