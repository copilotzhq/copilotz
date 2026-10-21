import { assert, assertEquals, assertExists } from "@std/assert";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "./index.ts";

for (const backend of ["memory", "postgres"] as const) {
  const url = backend === "memory"
    ? ":memory:"
    : Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
  Deno.test({
    name:
      `${backend}: a committed local preclaim belongs to one holder, store and start`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url! });
      const schema = `local_preclaim_${
        crypto.randomUUID().replaceAll("-", "")
      }`;
      await provisionCopilotzSchema(db, schema);
      const owner = await openDatabaseOwner(db, schema);
      const admitting = createEventStore({ session: db, schema });
      // Two gateways can share an owner queue, but not the right to start a preclaim.
      const other = createEventStore({ session: db, schema });
      try {
        const admitted = await admitting.commitMutation({
          draft: { type: "work", namespace: "tenant", payload: {} },
          consumers: [{ consumerId: "processor", settlement: "inherit" }],
          initialLocalClaim: { consumerId: "processor", owner: "attempt" },
        });
        const delivery = admitted.deliveries[0];
        const attempt = delivery.leaseOwner!;
        assert(attempt.startsWith(`${owner.holderId}:${owner.epoch}:`));
        assertEquals(await other.readLocalClaim(delivery.id, attempt), null);
        assertEquals(
          await other.claimDelivery({
            id: delivery.id,
            owner: "other-attempt",
            localExecution: true,
          }),
          null,
        );
        const starts = await Promise.all([
          admitting.readLocalClaim(delivery.id, attempt, true),
          admitting.readLocalClaim(delivery.id, attempt, true),
        ]);
        assertEquals(starts.filter(Boolean).length, 1);
        // Lifecycle reads remain valid; a second execution does not.
        assertExists(await admitting.readLocalClaim(delivery.id, attempt));
        assertEquals(
          await admitting.readLocalClaim(delivery.id, attempt, true),
          null,
        );
        // Even without local retirement, a durable takeover hides the old claim.
        await db.query(
          `UPDATE "${schema}".owner_epochs SET epoch=epoch+1,holder='successor'`,
        );
        assertEquals(
          await admitting.readLocalClaim(delivery.id, attempt),
          null,
        );
      } finally {
        await releaseDatabaseOwner(owner);
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
}
