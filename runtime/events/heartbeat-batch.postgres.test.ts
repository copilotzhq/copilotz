import {
  createHypervisor,
  type WorkerCallContext,
} from "../../dependencies/oxian-hypervisor.ts";
import { createOwnerCapabilityHost } from "../execution/owner-capabilities.ts";
import {
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "../execution/owner-capability-wire.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "./index.ts";
import type { DeliveryAttemptHeartbeat } from "./store.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
async function fixture(initial?: number) {
  const db = await createTestDatabase({ url: url!, pgPoolMax: 4 });
  const schema = `heartbeat_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let time = initial;
  const owner = await openDatabaseOwner(
    db,
    schema,
    initial === undefined ? {} : { now: () => new Date(time!) },
  );
  await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  const store = createEventStore({
    session: db,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  return {
    db,
    schema,
    owner,
    store,
    async renew(attempts: readonly DeliveryAttemptHeartbeat[]) {
      return (await store.heartbeatDeliveries(attempts)).map((attempt) =>
        attempt.id
      );
    },
    at(value: number) {
      time = value;
    },
    async attempt(localExecution = false): Promise<DeliveryAttemptHeartbeat> {
      const root = await store.append({
        namespace: "space",
        type: "test.heartbeat",
        payload: {},
      }, ["processor"]);
      const id = root.deliveries[0].id;
      assertExists(
        await store.claimDelivery({
          id,
          owner: `attempt-${id}`,
          leaseMs: 1000,
          localExecution,
        }),
      );
      return {
        id,
        owner: `attempt-${id}`,
        ownerEpoch: owner.epoch!,
        namespace: "space",
        eventId: root.event.id,
        operationId: root.deliveries[0].settlementScopeId,
        leaseMs: 1000,
      };
    },
    async close() {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "PostgreSQL heartbeat batches use captured command time, exact authority and atomic deadlines",
  ignore: !url,
  async fn(t) {
    for (const year of [2000, 2100]) {
      await t.step(`captured time ${year}`, async () => {
        const start = Date.UTC(year, 0, 1), f = await fixture(start);
        try {
          const a = await f.attempt(),
            b = await f.attempt(),
            local = await f.attempt(true);
          f.at(start + 999);
          assertEquals(
            (await f.renew([a, b, local])).toSorted(),
            [a.id, b.id].sort(),
          );
          for (const { id } of [a, b]) {
            assertEquals(
              (await f.store.getDelivery(id))?.leaseExpiresAt,
              new Date(start + 1999).toISOString(),
            );
            const row = (await f.db.query<{ due_at: Date }>(
              `SELECT due_at FROM ${f.store.tables.owner_deadlines} WHERE source='deliveries' AND key=$1`,
              [id],
            )).rows[0];
            assertEquals(
              new Date(row.due_at).toISOString(),
              new Date(start + 1999).toISOString(),
            );
          }
          assertEquals(
            (await f.store.getDelivery(local.id))?.leaseExpiresAt,
            undefined,
          );
          assertEquals(
            (await f.db.query(
              `SELECT key FROM ${f.store.tables.owner_deadlines} WHERE source='deliveries' AND key=$1`,
              [local.id],
            )).rows,
            [],
          );
          f.at(start + 1999);
          assertEquals(await f.renew([a, b]), []);
          f.at(start + 2000);
          assertEquals(await f.renew([a, b]), []);
        } finally {
          await f.close();
        }
      });
    }
    await t.step(
      "stale attempt, epoch, source and committed cancellation",
      async () => {
        const f = await fixture(Date.UTC(2000, 0, 1));
        try {
          const a = await f.attempt(), current = await f.attempt();
          for (
            const changed of [
              { owner: "stale" },
              { ownerEpoch: 0 },
              { eventId: "other" },
              { namespace: "other" },
              { operationId: "other" },
            ]
          ) {
            assertEquals(
              await f.renew([
                { ...a, ...changed },
                current,
              ]),
              [current.id],
            );
          }
          await f.db.query(
            `UPDATE ${f.store.tables.event_deliveries} SET owner_epoch=0 WHERE id=$1`,
            [a.id],
          );
          assertEquals(await f.renew([a, current]), [
            current.id,
          ]);
          await f.db.query(
            `UPDATE ${f.store.tables.event_deliveries} SET owner_epoch=$2 WHERE id=$1`,
            [a.id, f.owner.epoch],
          );
          const replacement = { ...a, owner: "replacement-attempt" };
          await f.db.query(
            `UPDATE ${f.store.tables.event_deliveries} SET lease_owner=$2 WHERE id=$1`,
            [a.id, replacement.owner],
          );
          assertEquals(await f.store.heartbeatDeliveries([a, replacement]), [{
            id: a.id,
            owner: replacement.owner,
          }]);
          await f.db.query(
            `UPDATE ${f.store.tables.event_deliveries} SET lease_owner=$2 WHERE id=$1`,
            [a.id, a.owner],
          );
          const signal = new AbortController().signal;
          await f.db.query(
            `UPDATE ${
              createOperationCatalogTables(f.schema).operations
            } SET cancellation_requested_at=NOW() WHERE operation_id=$1`,
            [a.operationId],
          );
          assertEquals(signal.aborted, false);
          assertEquals(await f.renew([a, current]), [
            current.id,
          ]);
          assertEquals(signal.aborted, false);
          await assertRejects(
            () => f.renew([]),
            RangeError,
          );
          await assertRejects(
            () => f.renew(Array(257).fill(a)),
            RangeError,
          );
          await assertRejects(
            () => f.renew([a, a]),
            TypeError,
          );
        } finally {
          await f.close();
        }
      },
    );
  },
});

Deno.test({
  name:
    "PostgreSQL an accepted heartbeat blocked behind the owner fence cannot resurrect an expired batch member",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocking: Promise<void> | undefined,
      renewing: Promise<readonly string[]> | undefined;
    try {
      const expired = await f.attempt(), current = await f.attempt();
      let expiresAt = 0;
      blocking = f.db.transaction(async (tx) => {
        await tx.query(
          `SELECT owner FROM ${f.store.tables.owner_epochs} WHERE owner='schema' FOR UPDATE`,
        );
        const expiry = await tx.query<{ deadline: Date }>(
          `UPDATE ${f.store.tables.event_deliveries} SET lease_expires_at=clock_timestamp()+INTERVAL '200 milliseconds' WHERE id=$1 RETURNING lease_expires_at AS deadline`,
          [expired.id],
        );
        expiresAt = new Date(expiry.rows[0].deadline).getTime();
        await tx.query(
          `UPDATE ${f.store.tables.event_deliveries} SET lease_expires_at=clock_timestamp()+INTERVAL '60 seconds' WHERE id=$1`,
          [current.id],
        );
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      renewing = f.renew([expired, current]);
      let waiting = false;
      const end = Date.now() + 10000;
      while (!waiting && Date.now() < end) {
        const result = await f.db.query<{ started: Date }>(
          `SELECT xact_start AS started FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()`,
          [`UPDATE ${f.store.tables.owner_epochs} SET holder=holder%`],
        );
        if (result.rows[0]) {
          assert(new Date(result.rows[0].started).getTime() < expiresAt);
          waiting = true;
        } else await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(
        waiting,
        "renewal must be blocked on the actual PostgreSQL owner fence",
      );
      while (Date.now() <= expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      release.resolve();
      await blocking;
      assertEquals(await renewing, [current.id]);
      assertEquals(
        new Date((await f.store.getDelivery(expired.id))!.leaseExpiresAt!)
          .getTime(),
        expiresAt,
      );
    } finally {
      release.resolve();
      await blocking;
      await renewing?.catch(() => {});
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL accepted session pulses renew blocked work but cannot revive it after waiting past expiry",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const attempt = await f.attempt();
    const hypervisor = createHypervisor({
      transports: [{
        type: "in-process",
        config: { topic: crypto.randomUUID() },
      }],
    });
    const sessions = hypervisor.sessions;
    const fence = sessions.attach({
      identity: {
        workerId: "blocked-worker",
        attemptId: "worker-attempt",
        epoch: 1,
      },
      connectionId: "blocked-connection",
      sessionGeneration: 1,
      transportType: "websocket",
      workloads: ["held"],
      capacity: 1,
      leaseTimeoutMs: 60_000,
    }).session;
    sessions.markReady(fence);
    type Renewed = readonly Pick<DeliveryAttemptHeartbeat, "id" | "owner">[];
    let observed = Promise.withResolvers<Renewed>();
    let renewing: Promise<Renewed> | undefined;
    const started = Promise.withResolvers<void>(),
      revoked = Promise.withResolvers<void>();
    let completed = false;
    const host = createOwnerCapabilityHost({
      sessions,
      registry: createPluginRegistry({}),
      resolveAuthority: () => f.store.executionAuthority(),
      createWorkloads: ({ trackAttempt }) => ({
        held: async (work) => {
          const abort = new AbortController();
          const signal = AbortSignal.any([work.signal, abort.signal]);
          const remove = trackAttempt!({
            store: {
              async heartbeatDeliveries(attempts, accept) {
                const notice = observed;
                renewing = f.store.heartbeatDeliveries(attempts, accept);
                try {
                  const result = await renewing;
                  notice.resolve(result);
                  return result;
                } catch (error) {
                  notice.reject(error);
                  throw error;
                }
              },
            },
            heartbeat: attempt,
            signal,
            revoke(reason) {
              abort.abort(reason);
              revoked.resolve();
            },
          });
          started.resolve();
          try {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
            completed = true;
            return {};
          } finally {
            remove();
          }
        },
      }),
    });
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocking: Promise<void> | undefined;
    try {
      // Make startup independent of machine speed; the first accepted pulse
      // deliberately resets this finite deadline to the declared 1-second lease.
      await f.db.query(
        `UPDATE ${f.store.tables.event_deliveries} SET lease_expires_at=clock_timestamp()+INTERVAL '60 seconds' WHERE id=$1`,
        [attempt.id],
      );
      const binding = {
        workload: OWNER_CAPABILITY_WORKLOAD,
        fence,
        parent: {
          streamId: "held",
          operationId: "held",
          workload: "held",
          metadata: { databaseSchema: f.schema, ownerEpoch: f.owner.epoch },
        },
        signal: new AbortController().signal,
      } as unknown as WorkerCallContext;
      const handler = await host.workerCalls.admit(binding);
      assert(handler);
      const response = await handler({
        signal: binding.signal,
        input: new ReadableStream({
          start(c) {
            c.enqueue(
              encodeCapability({ kind: "open", value: new Uint8Array() }),
            );
            c.close();
          },
        }),
      } as never) as Uint8Array;
      const result = await readCapability(
        new ReadableStream({
          start(c) {
            c.enqueue(response);
            c.close();
          },
        }),
      ) as { error?: Error };
      if (result.error) throw result.error;
      await started.promise;
      const before = Date.now();
      sessions.heartbeat(fence, {
        sequence: sessions.assertCurrent(fence).nextHeartbeatSequence,
      });
      assertEquals(await observed.promise, [{
        id: attempt.id,
        owner: attempt.owner,
      }]);
      const renewedAt = new Date(
        (await f.store.getDelivery(attempt.id))!.leaseExpiresAt!,
      ).getTime();
      assert(renewedAt >= before + 1000 && renewedAt <= Date.now() + 1000);
      assertEquals(
        completed,
        false,
        "transport liveness does not require work progress",
      );

      let expiresAt = 0;
      blocking = f.db.transaction(async (tx) => {
        await tx.query(
          `SELECT owner FROM ${f.store.tables.owner_epochs} WHERE owner='schema' FOR UPDATE`,
        );
        const expiry = await tx.query<{ deadline: Date }>(
          `UPDATE ${f.store.tables.event_deliveries} SET lease_expires_at=clock_timestamp()+INTERVAL '200 milliseconds' WHERE id=$1 RETURNING lease_expires_at AS deadline`,
          [attempt.id],
        );
        expiresAt = new Date(expiry.rows[0].deadline).getTime();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      observed = Promise.withResolvers<Renewed>();
      sessions.heartbeat(fence, {
        sequence: sessions.assertCurrent(fence).nextHeartbeatSequence,
      });
      let waiting = false;
      const end = Date.now() + 10000;
      while (!waiting && Date.now() < end) {
        const active = await f.db.query<{ started: Date }>(
          `SELECT xact_start AS started FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()`,
          [`UPDATE ${f.store.tables.owner_epochs} SET holder=holder%`],
        );
        if (active.rows[0]) {
          assert(new Date(active.rows[0].started).getTime() < expiresAt);
          waiting = true;
        } else await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(
        waiting,
        "the accepted session pulse must reach the actual held owner fence",
      );
      while (Date.now() <= expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      release.resolve();
      await blocking;
      assertEquals(await observed.promise, []);
      await revoked.promise;
      assertEquals(
        new Date((await f.store.getDelivery(attempt.id))!.leaseExpiresAt!)
          .getTime(),
        expiresAt,
      );
    } finally {
      release.resolve();
      await blocking;
      await renewing?.catch(() => {});
      await host.close();
      await hypervisor.shutdown();
      await f.close();
    }
  },
});
