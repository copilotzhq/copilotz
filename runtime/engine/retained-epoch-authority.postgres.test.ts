import { heartbeat } from "../testing/owner-helpers.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import type { SqlSession } from "../events/session.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import { createSchemaCommandRunner, openDatabaseOwner } from "./commands.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

async function fixture() {
  const db = await createTestDatabase({
    url: localPostgresUrl(url!),
    pgPoolMax: 4,
  });
  const schema = `retained_epoch_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  async function seed(
    label: string,
    epoch: number,
    expired = false,
    maxAttempts = 3,
  ) {
    const appended = await store.append(
      {
        type: "retained.authority",
        namespace: "space",
        payload: { label },
      },
      [`processor:${label}`],
      { maxAttempts },
    );
    const id = appended.deliveries[0].id;
    assertExists(
      await store.claimDelivery({
        id,
        owner: `original:${label}`,
        leaseMs: 3_600_000,
      }),
    );
    // Test-only retained corruption, not a public caller's authority. A future
    // epoch must remain evidence even when its deadline is already expired.
    await db.query(
      `UPDATE ${store.tables.event_deliveries}
       SET owner_epoch=$2, lease_expires_at=$3::timestamptz WHERE id=$1`,
      [id, epoch, expired ? "2000-01-01T00:00:00Z" : "2100-01-01T00:00:00Z"],
    );
    await db.query(
      `UPDATE ${store.tables.owner_deadlines} SET due_at=$2::timestamptz
       WHERE source='deliveries' AND key=$1`,
      [id, expired ? "2000-01-01T00:00:00Z" : "2100-01-01T00:00:00Z"],
    );
    return id;
  }
  async function snapshot() {
    const rows = async (table: string, order: string) =>
      (await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
    return {
      deliveries: await rows(store.tables.event_deliveries, "id"),
      deadlines: await rows(store.tables.owner_deadlines, "source,key"),
      receipts: await rows(store.tables.owner_receipts, "domain,key"),
      events: await rows(store.tables.events, "seq"),
      bodies: await rows(store.tables.event_bodies, "event_body_id"),
    };
  }
  return {
    db,
    schema,
    owner,
    store,
    seed,
    snapshot,
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "PostgreSQL prior recovery preserves current and terminal evidence and rolls back exactly",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const prior = await f.seed("prior", f.owner.epoch! - 1);
      const current = await f.seed("current", f.owner.epoch!);
      const terminal = await f.seed("terminal", f.owner.epoch!);
      assertExists(
        await f.store.succeedDelivery(terminal, "original:terminal"),
      );
      const before = await f.snapshot();
      assertEquals(
        await f.store.claimDelivery({ id: current, owner: "wrong" }),
        null,
      );
      assertEquals(
        await f.store.claimDelivery({ id: terminal, owner: "wrong" }),
        null,
      );
      assertEquals(await f.store.succeedDelivery(current, "wrong"), null);
      assertEquals(
        await heartbeat(f.store, { id: current, owner: "wrong" }),
        false,
      );
      const afterRefusals = await f.snapshot();
      assertEquals(afterRefusals.deliveries, before.deliveries);
      assertEquals(afterRefusals.events, before.events);
      assertEquals(afterRefusals.bodies, before.bodies);
      assertEquals(afterRefusals.receipts, before.receipts);
      const semanticDeadlines = (rows: typeof before.deadlines) =>
        rows.map(({ revision: _revision, ...row }) => row);
      assertEquals(
        semanticDeadlines(afterRefusals.deadlines),
        semanticDeadlines(before.deadlines),
      );
      // Refused same-epoch commands may rearm the same deadline with a new
      // revision. The following rollback must restore even that exact revision.
      const beforeRollback = await f.snapshot();
      const run = createSchemaCommandRunner(f.db, f.schema);
      await assertRejects(
        () =>
          run("fixture.rollbackPrior", {}, async (_input, ctx) => {
            const joined = createEventStore({
              session: ctx.transaction as SqlSession,
              schema: f.schema,
            });
            assertExists(
              await joined.claimDelivery({ id: prior, owner: "rolled-back" }),
            );
            throw new Error("definitive fixture rollback");
          }),
        Error,
        "definitive fixture rollback",
      );
      assertEquals(
        await f.snapshot(),
        beforeRollback,
        "prior takeover and deadline must roll back together",
      );
      const claimed = await f.store.claimDelivery({
        id: prior,
        owner: "replacement",
        localExecution: true,
      });
      assertExists(claimed);
      assertEquals(claimed.attempts, 2);
      assertEquals(claimed.leaseExpiresAt, undefined);
      assertEquals(
        await f.store.succeedDelivery(prior, "original:prior"),
        null,
      );
      const after = await f.snapshot();
      assertEquals(
        after.deliveries.filter((row) => row.id !== prior),
        before.deliveries.filter((row) => row.id !== prior),
      );
      assertEquals(after.events, before.events);
      assertEquals(after.bodies, before.bodies);
      assertEquals(after.receipts, before.receipts);
    } finally {
      await f.close();
    }
  },
});
