import { heartbeat } from "../testing/owner-helpers.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "./index.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

async function fixture(initial?: number) {
  const db = await createTestDatabase({ url: url!, pgPoolMax: 4 });
  const schema = `command_clock_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let time = initial;
  const owner = await openDatabaseOwner(db, schema, {
    ...(initial === undefined ? {} : { now: () => new Date(time!) }),
  });
  const store = createEventStore({ session: db, schema });
  const root = await store.append({
    type: "clock.work",
    namespace: "space",
    payload: {},
  }, ["processor"]);
  const id = root.deliveries[0].id;
  return {
    db,
    schema,
    store,
    id,
    root,
    at(value: number) {
      time = value;
    },
    async lease(deadline: number | null, epoch = owner.epoch) {
      await db.query(
        `UPDATE ${store.tables.event_deliveries}
         SET status='leased',lease_owner='attempt',lease_expires_at=$2::timestamptz,
             owner_epoch=$3,attempts=1 WHERE id=$1`,
        [
          id,
          deadline === null ? null : new Date(deadline).toISOString(),
          epoch,
        ],
      );
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
    "PostgreSQL claims, renewals, retries and settlement share the captured command clock",
  ignore: !url,
  async fn(t) {
    for (const year of [2000, 2100]) {
      await t.step(
        `command time ${
          year === 2000 ? "earlier" : "later"
        } than transaction time`,
        async () => {
          const start = Date.UTC(year, 0, 1);
          const f = await fixture(start);
          const iso = (offset: number) =>
            new Date(start + offset).toISOString();
          try {
            assertEquals(f.root.deliveries[0].availableAt, iso(0));
            const claimed = await f.store.claimDelivery({
              id: f.id,
              owner: "attempt",
              leaseMs: 1000,
            });
            assertExists(claimed);
            assertEquals(claimed.leaseExpiresAt, iso(1000));
            assertEquals(claimed.updatedAt, iso(0));
            f.at(start + 500);
            assertEquals(
              await heartbeat(f.store, {
                id: f.id,
                owner: "attempt",
                leaseMs: 1000,
              }),
              true,
            );
            assertEquals(
              (await f.store.getDelivery(f.id))?.leaseExpiresAt,
              iso(1500),
            );
            const retry = await f.store.failDelivery({
              id: f.id,
              owner: "attempt",
              error: new Error("retry"),
              backoffMs: 2000,
            });
            assertEquals(retry?.status, "retry_wait");
            assertEquals(retry?.availableAt, iso(2500));
            assertEquals(retry?.updatedAt, iso(500));
            f.at(start + 2499);
            assertEquals(
              await f.store.claimDelivery({ id: f.id, owner: "too-early" }),
              null,
            );
            assertEquals(
              await f.store.claimDelivery({ id: f.id, owner: "too-early" }),
              null,
            );
            f.at(start + 2500);
            const next = await f.store.claimDelivery({
              id: f.id,
              owner: "next",
              leaseMs: 1000,
            });
            assertEquals(next?.id, f.id);
            assertEquals(next?.leaseExpiresAt, iso(3500));
            assertEquals(next?.attempts, 2);
            f.at(start + 3000);
            const settled = await f.store.succeedDelivery(f.id, "next");
            assertEquals(settled?.status, "succeeded");
            assertEquals(settled?.settledAt, iso(3000));
          } finally {
            await f.close();
          }
        },
      );
    }
  },
});

Deno.test({
  name:
    "PostgreSQL mutation authority expires exactly at captured command time and keeps local NULL deadlines",
  ignore: !url,
  async fn(t) {
    const deadline = Date.UTC(2000, 0, 1);
    const f = await fixture(deadline - 1);
    try {
      for (const offset of [-1, 0, 1]) {
        await t.step(`deadline offset ${offset}`, async () => {
          const live = offset < 0;
          f.at(deadline + offset);
          await f.lease(deadline);
          assertEquals(
            await heartbeat(f.store, { id: f.id, owner: "attempt" }),
            live,
          );
          await f.lease(deadline);
          assertEquals(
            (await f.store.succeedDelivery(f.id, "attempt"))?.status ?? null,
            live ? "succeeded" : null,
          );
          await f.lease(deadline);
          assertEquals(
            (await f.store.failDelivery({
              id: f.id,
              owner: "attempt",
              error: new Error("retry"),
            }))?.status ?? null,
            live ? "retry_wait" : null,
          );
          await f.lease(deadline);
          const append = () =>
            f.store.append({
              type: "clock.mutation",
              namespace: "space",
              payload: {},
              deliveryLease: { deliveryId: f.id, owner: "attempt" },
            });
          if (live) await append();
          else await assertRejects(append, Error, "was not inserted");
          await f.lease(deadline);
          assertEquals(
            (await f.store.claimDelivery({ id: f.id, owner: "replacement" }))
              ?.leaseOwner ?? null,
            live ? null : "replacement",
          );
        });
      }
      await f.lease(null);
      f.at(Date.UTC(2100, 0, 1));
      assertEquals(
        await heartbeat(f.store, { id: f.id, owner: "attempt" }),
        false,
      );
      assertEquals(
        (await f.store.getDelivery(f.id))?.leaseExpiresAt,
        undefined,
      );
      assertEquals(await f.store.succeedDelivery(f.id, "wrong-attempt"), null);
      assertEquals(
        (await f.store.succeedDelivery(f.id, "attempt"))?.status,
        "succeeded",
      );
      await f.lease(null, 0);
      assertEquals(await f.store.succeedDelivery(f.id, "attempt"), null);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL a lease expiring behind the owner fence cannot be renewed with transaction-start NOW",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blocking: Promise<void> | undefined;
    let renewing: Promise<boolean> | undefined;
    try {
      assertExists(
        await f.store.claimDelivery({
          id: f.id,
          owner: "attempt",
          leaseMs: 60_000,
        }),
      );
      let expiresAt = 0;
      blocking = f.db.transaction(async (tx) => {
        await tx.query(
          `SELECT owner FROM ${f.store.tables.owner_epochs} WHERE owner='schema' FOR UPDATE`,
        );
        const expiry = await tx.query<{ deadline: Date }>(
          `UPDATE ${f.store.tables.event_deliveries}
           SET lease_expires_at=clock_timestamp()+INTERVAL '200 milliseconds'
           WHERE id=$1 RETURNING lease_expires_at AS deadline`,
          [f.id],
        );
        expiresAt = new Date(expiry.rows[0].deadline).getTime();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      renewing = heartbeat(f.store, {
        id: f.id,
        owner: "attempt",
        leaseMs: 60_000,
      });
      // Prove this command began before the deadline and is waiting on the
      // actual PostgreSQL row lock, rather than merely delayed in JavaScript.
      let waiting = false;
      const end = Date.now() + 10_000;
      while (!waiting && Date.now() < end) {
        const result = await f.db.query<{ started: Date }>(
          `SELECT xact_start AS started FROM pg_stat_activity
           WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()`,
          [`UPDATE ${f.store.tables.owner_epochs} SET holder=holder%`],
        );
        if (result.rows[0]) {
          assert(new Date(result.rows[0].started).getTime() < expiresAt);
          waiting = true;
        } else await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(waiting, "owner command must wait on the held fence");
      while (Date.now() <= expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      release.resolve();
      await blocking;
      assertEquals(await renewing, false);
      assertEquals(
        new Date((await f.store.getDelivery(f.id))!.leaseExpiresAt!).getTime(),
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
