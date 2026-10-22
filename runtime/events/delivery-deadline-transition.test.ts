import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "./schema.ts";
import { createEventStore } from "./store.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { reconciliationAlarmKey } from "../engine/alarms.ts";

Deno.test("delivery transitions atomically maintain deadlines and exact reconciliation keys", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 1,
  });
  const schema = `perf_delivery_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  let fail = false;
  const store = createEventStore({
    session: db,
    schema,
    settleActionOwners() {
      if (fail) throw new Error("rollback settlement");
      return Promise.resolve();
    },
  });
  const namespace = 'space, "quoted" \\ ✓';
  const deadlines = async () =>
    (await db.query<
      { source: string; key: string; payload: unknown; due_at: Date }
    >(
      `SELECT source,key,payload,due_at FROM "${schema}".owner_deadlines ORDER BY source,key`,
    )).rows;
  try {
    const event = await store.append({ type: "test", namespace, payload: {} }, [
      "worker",
    ]);
    const id = event.deliveries[0].id;
    assertEquals((await deadlines()).map((row) => row.source), ["deliveries"]);
    const claimed = await store.claimDelivery({
      id,
      owner: "worker",
      leaseMs: 60_000,
    });
    assertExists(claimed);
    assertEquals(
      new Date((await deadlines())[0].due_at).toISOString(),
      claimed.leaseExpiresAt,
    );
    assertEquals(await store.claimDelivery({ id, owner: "other" }), null);
    assertEquals(await store.succeedDelivery(id, "other"), null);
    assertEquals((await deadlines()).map((row) => row.source), ["deliveries"]);
    fail = true;
    await assertRejects(
      () => store.succeedDelivery(id, "worker"),
      Error,
      "rollback settlement",
    );
    assertEquals((await store.getDelivery(id))?.status, "leased");
    assertEquals((await deadlines()).map((row) => row.source), ["deliveries"]);
    fail = false;
    await store.succeedDelivery(id, "worker");
    const [deadline] = await deadlines();
    assertEquals(deadline.source, "reconciliation");
    assertEquals(
      deadline.key,
      reconciliationAlarmKey("schema", {
        kind: "operation",
        namespace,
        id: event.event.id,
      }),
    );
    assertEquals(deadline.payload, { operationId: event.event.id });
    const local = await store.append(
      { type: "local", namespace, payload: {} },
      ["worker"],
    );
    await store.claimDelivery({
      id: local.deliveries[0].id,
      owner: "local",
      localExecution: true,
    });
    assertEquals(
      (await deadlines()).filter((row) => row.source === "deliveries"),
      [],
    );
  } finally {
    await releaseDatabaseOwner(owner);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
