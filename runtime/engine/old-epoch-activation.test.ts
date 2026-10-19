import { assert, assertEquals, assertExists } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createPluginRegistry, defineProcessor } from "../plugins/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "./commands.ts";
import { createCopilotzEngine } from "./engine.ts";

Deno.test("successor activation arms immediate recovery for old local and remote attempts", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  const schema = `old_epoch_alarm_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const oldOwner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const calls: string[] = [];
  const completed = Promise.withResolvers<void>();
  const processor = defineProcessor({
    id: "test.recovered",
    on: [{ eventType: "test.retained" }],
    handle(event) {
      assert(event.durable);
      calls.push(event.id);
    },
  });
  const deliveries = [];
  for (const localExecution of [true, false]) {
    const committed = await store.append({
      type: "test.retained",
      namespace: "space",
      payload: {},
    }, ["processor:test.recovered"]);
    const delivery = await store.claimDelivery({
      id: committed.deliveries[0].id,
      owner: localExecution ? "old-local" : "old-remote",
      localExecution,
      leaseMs: 3_600_000,
    });
    assertExists(delivery);
    deliveries.push(delivery);
  }
  assertEquals(deliveries[0].leaseExpiresAt, undefined);
  assertEquals(
    (await db.query(
      `SELECT key FROM ${store.tables.owner_deadlines} WHERE source='deliveries' AND key=$1`,
      [deliveries[0].id],
    )).rows,
    [],
  );
  assert(
    new Date(deliveries[1].leaseExpiresAt!).getTime() > Date.now() + 3_000_000,
  );
  oldOwner.stop();
  const alarms = new Map<object, { callback(): void; delay: number }>();
  let settled = 0;
  const engine = await createCopilotzEngine({
    session: db,
    defaultDatabaseSchema: schema,
    registry: createPluginRegistry({ processors: { recovered: processor } }),
    execution: {
      onDeliverySettled(result) {
        assertEquals(result.delivery.status, "succeeded");
        if (++settled === 2) completed.resolve();
      },
    },
    alarmScheduler: {
      schedule(callback, delay) {
        const handle = {};
        alarms.set(handle, { callback, delay });
        return handle;
      },
      cancel(handle) {
        alarms.delete(handle as object);
      },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const owner = await openDatabaseOwner(db, schema);
  try {
    await owner.rearmAlarms();
    assertEquals(calls, []);
    const deadlines = (await db.query<{ key: string; due_at: Date | string }>(
      `SELECT key,due_at FROM ${store.tables.owner_deadlines} WHERE source='deliveries' ORDER BY key`,
    )).rows;
    assertEquals(
      deadlines.map((row) => row.key).sort(),
      deliveries.map((d) => d.id).sort(),
    );
    for (const deadline of deadlines) {
      assert(new Date(deadline.due_at).getTime() <= Date.now());
    }
    for (const delivery of deliveries) {
      const current = await store.getDelivery(delivery.id);
      assertEquals(current?.attempts, 1);
      assertEquals(current?.status, "leased");
      assertEquals(
        Number(
          (await db.query<{ owner_epoch: number }>(
            `SELECT owner_epoch FROM ${store.tables.event_deliveries} WHERE id=$1`,
            [delivery.id],
          )).rows[0].owner_epoch,
        ),
        oldOwner.epoch,
      );
    }
    const armed = [...alarms.values()];
    assertEquals(armed.length, 1);
    assertEquals(armed[0].delay, 0);
    armed[0].callback();
    await Promise.race([
      completed.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("The activation alarm did not recover both attempts."),
            ),
          5000,
        );
      }),
    ]);
    await engine.execution.settleOutputs({
      databaseSchema: schema,
      namespace: "space",
      settlementScopeId: deliveries[0].settlementScopeId,
    });
    await engine.execution.settleOutputs({
      databaseSchema: schema,
      namespace: "space",
      settlementScopeId: deliveries[1].settlementScopeId,
    });
    for (const delivery of deliveries) {
      const current = await store.getDelivery(delivery.id);
      assertEquals(current?.attempts, 2);
      assertEquals(
        Number(
          (await db.query<{ owner_epoch: number }>(
            `SELECT owner_epoch FROM ${store.tables.event_deliveries} WHERE id=$1`,
            [delivery.id],
          )).rows[0].owner_epoch,
        ),
        owner.epoch,
      );
      assertEquals(current?.status, "succeeded");
    }
    assertEquals(calls.sort(), deliveries.map((d) => d.eventId).sort());
    assertEquals(
      (await db.query(
        `SELECT key FROM ${store.tables.owner_deadlines} WHERE source='deliveries'`,
      )).rows,
      [],
    );
  } finally {
    clearTimeout(timeout);
    releaseDatabaseOwner(owner);
    await engine.shutdown();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
