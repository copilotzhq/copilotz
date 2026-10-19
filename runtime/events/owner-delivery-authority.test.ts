import { claimFirst, heartbeat } from "../testing/owner-helpers.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { openDatabaseOwner } from "../engine/commands.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
} from "./index.ts";

for (const backend of ["memory", "postgres"] as const) {
  const url = backend === "memory"
    ? ":memory:"
    : Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
  Deno.test({
    name:
      `${backend}: owner-local attempts have epoch authority without lease deadlines`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url! });
      const schema = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await provisionCopilotzSchema(db, schema);
        const store = createEventStore({ session: db, schema });
        const committed = await store.append({
          type: "work.created",
          namespace: "scope-a",
          payload: {},
        }, ["processor"]);
        const id = committed.deliveries[0].id;
        const claim = await store.claimDelivery({
          id,
          owner: "local-attempt",
          localExecution: true,
          leaseMs: 0,
        });
        assertExists(claim);
        assertEquals(claim.leaseExpiresAt, undefined);
        assertEquals(
          (await db.query(
            `SELECT key FROM ${store.tables.owner_deadlines} WHERE source='deliveries' AND key=$1`,
            [id],
          )).rows,
          [],
        );
        assertEquals(await store.listRecoverable(), []);
        assertEquals(
          await heartbeat(store, { id, owner: "local-attempt" }),
          false,
        );
        assertEquals(
          (await store.succeedDelivery(id, "local-attempt"))?.status,
          "succeeded",
        );
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
  Deno.test({
    name:
      `${backend}: successor epoch recovers local and remote work immediately and rejects old attempts`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url! });
      const schema = `takeover_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await provisionCopilotzSchema(db, schema);
        const store = createEventStore({ session: db, schema });
        const committed = await store.append({
          type: "work.created",
          namespace: "scope-a",
          payload: {},
        }, ["local", "remote"]);
        const local = committed.deliveries.find((d) =>
          d.consumerId === "local"
        )!;
        const remote = committed.deliveries.find((d) =>
          d.consumerId === "remote"
        )!;
        await store.claimDelivery({
          id: local.id,
          owner: "old-local",
          localExecution: true,
        });
        await store.claimDelivery({
          id: remote.id,
          owner: "old-remote",
          leaseMs: 86_400_000,
        });
        const previous = await openDatabaseOwner(db, schema);
        previous.stop(new Error("simulated process loss"));
        const session: SqlSession = {
          query: db.query,
          transaction: db.transaction,
        };
        const successor = createEventStore({ session, schema });
        const authority = await successor.executionAuthority();
        assertEquals(authority.epoch, previous.epoch! + 1);
        await assertRejects(
          () => store.executionAuthority(),
          Error,
          "simulated process loss",
        );
        assertEquals(
          (await successor.listRecoverable()).map((d) => d.id).sort(),
          [local.id, remote.id].sort(),
        );
        assertEquals(
          await successor.succeedDelivery(local.id, "old-local"),
          null,
        );
        assertEquals(
          await heartbeat(successor, {
            id: remote.id,
            owner: "old-remote",
          }),
          false,
        );
        await assertRejects(() =>
          successor.append({
            type: "stale.write",
            namespace: "scope-a",
            payload: {},
            deliveryLease: { deliveryId: local.id, owner: "old-local" },
          })
        );
        assertEquals(
          (await successor.claimDelivery({
            id: local.id,
            owner: "new-local",
            localExecution: true,
          }))?.attempts,
          2,
        );
        assertEquals(
          (await successor.claimDelivery({
            id: remote.id,
            owner: "new-remote",
          }))?.attempts,
          2,
        );
        assertEquals(
          (await successor.succeedDelivery(local.id, "new-local"))?.status,
          "succeeded",
        );
        assertEquals(
          (await successor.succeedDelivery(remote.id, "new-remote"))?.status,
          "succeeded",
        );
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
  Deno.test({
    name:
      `${backend}: serialized claim race has one winner and preserves availability order`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url! });
      const schema = `claim_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await provisionCopilotzSchema(db, schema);
        const store = createEventStore({ session: db, schema });
        const first = await store.append({
          type: "work.created",
          namespace: "scope-a",
          payload: { ordinal: 1 },
        }, ["processor"]);
        const second = await store.append({
          type: "work.created",
          namespace: "scope-a",
          payload: { ordinal: 2 },
        }, ["processor"]);
        const winners = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.claimDelivery({
              id: first.deliveries[0].id,
              owner: `attempt-${i}`,
              localExecution: true,
            })),
        );
        assertEquals(winners.filter(Boolean).length, 1);
        assertEquals(
          (await claimFirst(store, { owner: "next" }))?.id,
          second.deliveries[0].id,
        );
        assertEquals(await claimFirst(store, { owner: "empty" }), null);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
}
