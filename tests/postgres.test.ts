import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDatabase } from "../database/database.ts";
import { EventStore } from "../database/event-store.ts";

const postgresUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test({
  name:
    "PostgreSQL preserves v2 event, delivery, dedupe, and tenant invariants",
  ignore: !postgresUrl,
  async fn() {
    const schema = `copilotz_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = await createDatabase({ url: postgresUrl, schema });
    const store = new EventStore(database.session, schema);
    try {
      await assertRejects(() =>
        store.commitMutation({
          draft: {
            type: "postgres.rollback",
            namespace: "tenant-a",
            payload: 1n,
          },
          consumerIds: ["consumer"],
          mutate: async (transaction) => {
            await transaction.query(
              `INSERT INTO ${store.table("nodes")} (
                id, namespace, type, name, data, created_at, updated_at
              ) VALUES ('rollback', 'tenant-a', 'test', 'rollback', '{}', NOW(), NOW())`,
            );
          },
        })
      );
      assertEquals(
        Number(
          (await store.read<{ count: string | number }>(
            `SELECT COUNT(*) AS count FROM ${store.table("nodes")}`,
          )).rows[0].count,
        ),
        0,
      );

      const first = await store.append({
        type: "postgres.created",
        namespace: "tenant-a",
        payload: { value: 1 },
        correlationId: "postgres-correlation",
        deduplicationId: "postgres-dedupe",
      }, ["consumer", "consumer"]);
      const duplicate = await store.append({
        type: "postgres.created",
        namespace: "tenant-a",
        payload: { value: 2 },
        correlationId: "postgres-correlation",
        deduplicationId: "postgres-dedupe",
      }, ["consumer"]);
      const otherTenant = await store.append({
        type: "postgres.created",
        namespace: "tenant-b",
        payload: { value: 3 },
        correlationId: "other-tenant",
      }, []);
      assertEquals(duplicate.event.id, first.event.id);
      assertEquals(first.deliveries.length, 1);
      assert(first.event.position < otherTenant.event.position);
      assertEquals(
        (await store.listEvents({ namespace: "tenant-a" })).length,
        1,
      );
      assertEquals(
        (await store.listEvents({ namespace: "tenant-b" })).length,
        1,
      );

      const delivery = first.deliveries[0];
      const claimed = await store.claimDelivery({
        id: delivery.id,
        owner: "postgres-owner",
        leaseMs: 1_000,
      });
      assertEquals(claimed?.status, "leased");
      assertEquals(
        await store.heartbeatDelivery({
          id: delivery.id,
          owner: "postgres-owner",
          leaseMs: 1_000,
        }),
        true,
      );
      await store.failDelivery({
        id: delivery.id,
        owner: "postgres-owner",
        error: new Error("retry"),
        backoffMs: 0,
      });
      assertEquals(
        (await store.getDelivery(delivery.id))?.status,
        "retry_wait",
      );
      assertEquals(
        await store.cancelCorrelation(
          "tenant-a",
          "postgres-correlation",
          "test",
        ),
        1,
      );
      assertEquals((await store.getDelivery(delivery.id))?.status, "cancelled");
    } finally {
      await database.session.query(
        `DROP SCHEMA ${store.table("nodes").split(".")[0]} CASCADE`,
      );
      await database.close();
    }
  },
});
