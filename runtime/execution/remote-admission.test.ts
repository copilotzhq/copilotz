import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createDeliveryWorkload } from "./workload.ts";
import {
  prepareRemoteAdmission,
  registerRemoteAdmission,
  remoteClaimSession,
} from "./remote-admission.ts";

for (const backend of ["memory", "postgres"] as const) {
  const url = backend === "memory"
    ? ":memory:"
    : Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
  Deno.test({
    name:
      `${backend}: remote admission fences session, holder, epoch, lease and one start`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url! });
      const schema = `remote_claim_${crypto.randomUUID().replaceAll("-", "")}`;
      await provisionCopilotzSchema(db, schema);
      const owner = await openDatabaseOwner(db, schema);
      const store = createEventStore({ session: db, schema });
      const other = createEventStore({ session: db, schema });
      const dispatcher = createHypervisor({
        transports: [{
          type: "in-process",
          config: { topic: crypto.randomUUID() },
        }],
      });
      const attach = (generation: number) => {
        const session = dispatcher.sessions.attach({
          identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
          connectionId: `connection-${generation}`,
          sessionGeneration: generation,
          transportType: "in-process",
          workloads: ["copilotz.delivery.v1"],
          capacity: 16,
          leaseTimeoutMs: 120_000,
        }).session;
        return dispatcher.sessions.markReady(session);
      };
      const first = attach(1);
      // Already-ready sessions must be eligible without waiting for a heartbeat.
      const unregister = registerRemoteAdmission(
        dispatcher,
        dispatcher.sessions,
      );
      const prepare = () =>
        prepareRemoteAdmission(dispatcher, "copilotz.delivery.v1", "worker")!;
      const admit = (claim = prepare()) =>
        store.commitMutation({
          draft: { type: "request", namespace: "tenant", payload: {} },
          consumers: [{ consumerId: claim.consumerId, settlement: "inherit" }],
          initialRemoteClaim: claim,
        });
      try {
        assertEquals(
          prepareRemoteAdmission(dispatcher, "copilotz.delivery.v1", "other"),
          undefined,
        );
        const result = await admit();
        const delivery = result.deliveries[0];
        const attempt = delivery.leaseOwner!;
        assert(attempt.startsWith(`${owner.holderId}:${owner.epoch}:`));
        assertEquals(remoteClaimSession(attempt), {
          identity: first.identity,
          connectionId: first.connectionId,
          sessionGeneration: 1,
        });
        assertEquals(delivery.attempts, 1);
        assert(delivery.leaseExpiresAt);
        const deadline = (await db.query(
          `SELECT due_at FROM "${schema}".owner_deadlines WHERE source='deliveries' AND key=$1`,
          [delivery.id],
        )).rows[0];
        assertEquals(
          new Date(deadline.due_at as string).toISOString(),
          delivery.leaseExpiresAt,
        );
        assertEquals(
          await other.readRemoteClaim(delivery.id, attempt, true),
          null,
        );
        assertEquals(
          await store.readLocalClaim(delivery.id, attempt, true),
          null,
        );
        const workload = createDeliveryWorkload({
          store,
          registry: createPluginRegistry({}),
          remoteSession: { ...first, connectionId: "other" },
          createContext: () => {
            throw new Error("must never execute");
          },
        });
        await assertRejects(
          async () =>
            await workload(
              {
                streamId: "test",
                workload: "copilotz.delivery.v1",
                input: new ReadableStream({
                  start(controller) {
                    controller.close();
                  },
                }),
                sendMetadata: () => Promise.resolve(),
                callHost: () => Promise.reject(new Error("must never call")),
                metadata: {
                  schema: "copilotz.delivery.dispatch.v1",
                  databaseSchema: schema,
                  ownerEpoch: owner.epoch!,
                  deliveryId: delivery.id,
                  eventId: delivery.eventId,
                  consumerId: delivery.consumerId,
                  namespace: "tenant",
                  dispatchAttemptId: attempt,
                  idempotencyKey: delivery.id,
                },
                signal: new AbortController().signal,
              },
            ),
          Error,
          "another worker session",
        );
        // Rejection by another session did not consume the rightful start.
        const starts = await Promise.all([
          store.readRemoteClaim(delivery.id, attempt, true),
          store.readRemoteClaim(delivery.id, attempt, true),
        ]);
        assertEquals(starts.filter(Boolean).length, 1);
        assert(await store.readRemoteClaim(delivery.id, attempt));
        const stale = prepare();
        attach(2);
        await assertRejects(() => admit(stale));
        assertEquals((await store.listDeliveries()).length, 1);
        const expired = (await admit()).deliveries[0];
        await db.query(
          `UPDATE "${schema}".event_deliveries SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`,
          [expired.id],
        );
        assertEquals(
          await store.readRemoteClaim(expired.id, expired.leaseOwner!, true),
          null,
        );
        await db.query(
          `UPDATE "${schema}".owner_epochs SET epoch=epoch+1,holder='successor'`,
        );
        assertEquals(await store.readRemoteClaim(delivery.id, attempt), null);
      } finally {
        unregister();
        await dispatcher.shutdown();
        releaseDatabaseOwner(owner);
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
}
