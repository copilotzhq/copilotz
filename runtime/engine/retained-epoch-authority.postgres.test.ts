import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import type { SqlSession } from "../events/session.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import {
  createOwnerCommands,
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "./commands.ts";
import { createCopilotzEngine } from "./engine.ts";

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
        await f.store.heartbeatDelivery({ id: current, owner: "wrong" }),
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

for (const route of ["claim", "claimNext", "exhaust"] as const) {
  for (const expired of [false, true]) {
    Deno.test({
      name: `PostgreSQL ${route} preserves future-epoch evidence with ${
        expired ? "expired" : "unexpired"
      } deadline`,
      ignore: !url,
      async fn() {
        const f = await fixture();
        try {
          const id = await f.seed(
            "future",
            f.owner.epoch! + 2,
            expired,
            route === "exhaust" ? 1 : 3,
          );
          const before = await f.snapshot();
          const refusal = await assertRejects(
            () =>
              route === "claim"
                ? f.store.claimDelivery({ id, owner: "must-not-replace" })
                : route === "claimNext"
                ? f.store.claimNext({ owner: "must-not-replace" })
                : f.store.recoverExpiredDeliveries(),
            Error,
            "Retained delivery authority is ahead of the current owner epoch.",
          );
          assertEquals(
            (refusal as Error & { code?: string }).code,
            "delivery_future_epoch",
          );
          assertEquals(
            await f.snapshot(),
            before,
            "future authority evidence must be unchanged before refusal",
          );
        } finally {
          await f.close();
        }
      },
    });
  }
}

Deno.test({
  name:
    "PostgreSQL activation refuses an expired future epoch without rewriting retained evidence",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let engine: Awaited<ReturnType<typeof createCopilotzEngine>> | undefined;
    try {
      await f.seed("future-startup", f.owner.epoch! + 2, true, 1);
      const before = await f.snapshot();
      f.owner.stop();
      let refused: unknown;
      try {
        engine = await createCopilotzEngine({
          session: f.db,
          defaultDatabaseSchema: f.schema,
          registry: createPluginRegistry(),
          alarmScheduler: { schedule: () => ({}), cancel() {} },
        });
      } catch (error) {
        refused = error;
      }
      assertEquals(
        await f.snapshot(),
        before,
        "activation must not rewrite future authority into stale/exhausted work",
      );
      assert(refused, "future epoch must prevent owner readiness");
      assertEquals(
        (refused as Error & { code?: string }).code,
        "delivery_future_epoch",
      );
      assertEquals(engine, undefined);
    } finally {
      await engine?.shutdown();
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL repeated activation cannot make future authority valid by advancing epochs",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const observations: Array<
      {
        attempt: number;
        refused: boolean;
        epoch: unknown;
        retainedUnchanged: boolean;
      }
    > = [];
    try {
      await f.seed("future-repeated-startup", f.owner.epoch! + 2, true, 1);
      const before = await f.snapshot();
      const ownerBefore = (await f.db.query(
        `SELECT * FROM ${f.store.tables.owner_epochs} ORDER BY owner`,
      )).rows;
      f.owner.stop();
      for (let attempt = 1; attempt <= 3; attempt++) {
        let engine:
          | Awaited<ReturnType<typeof createCopilotzEngine>>
          | undefined;
        let refused = false;
        try {
          engine = await createCopilotzEngine({
            session: f.db,
            defaultDatabaseSchema: f.schema,
            registry: createPluginRegistry(),
            alarmScheduler: { schedule: () => ({}), cancel() {} },
          });
        } catch {
          refused = true;
        } finally {
          await engine?.shutdown();
        }
        const ownerAfter = (await f.db.query(
          `SELECT * FROM ${f.store.tables.owner_epochs} ORDER BY owner`,
        )).rows;
        observations.push({
          attempt,
          refused,
          epoch: ownerAfter[0]?.epoch,
          retainedUnchanged:
            JSON.stringify(await f.snapshot()) === JSON.stringify(before),
        });
      }
      console.log("repeated-startup-evidence", JSON.stringify(observations));
      assert(
        observations.every((row) => row.refused),
        "every startup must refuse future authority",
      );
      assertEquals(
        await f.snapshot(),
        before,
        "retries must preserve retained evidence",
      );
      assertEquals(
        (await f.db.query(
          `SELECT * FROM ${f.store.tables.owner_epochs} ORDER BY owner`,
        )).rows,
        ownerBefore,
        "refused startup must not increment the durable owner epoch",
      );
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL bare owner acquisition rejects exact bigint future authority for every active status",
  ignore: !url,
  async fn(t) {
    for (const status of ["pending", "retry_wait", "leased"]) {
      await t.step(status, async () => {
        const f = await fixture();
        try {
          const id = await f.seed("future-bigint", f.owner.epoch! + 1, true);
          await f.db.query(
            `UPDATE ${f.store.tables.event_deliveries} SET owner_epoch=$2::bigint,status=$3 WHERE id=$1`,
            [id, "9007199254740993", status],
          );
          const before = await f.snapshot();
          const ownerBefore = (await f.db.query(
            `SELECT * FROM ${f.store.tables.owner_epochs} ORDER BY owner`,
          )).rows;
          const epoch = f.owner.epoch!;
          f.owner.stop();
          for (let attempt = 0; attempt < 2; attempt++) {
            const next = createOwnerCommands({
              session: f.db,
              schema: f.schema,
              handlers: {},
            });
            const refusal = await assertRejects(
              () => next.acquire(epoch),
              Error,
              "Retained delivery authority is ahead of the current owner epoch.",
            );
            assertEquals(
              (refusal as Error & { code?: string }).code,
              "delivery_future_epoch",
            );
            assertEquals(next.state, "stopped");
            assertEquals(next.epoch, undefined);
            assertEquals(await f.snapshot(), before);
            assertEquals(
              (await f.db.query(
                `SELECT * FROM ${f.store.tables.owner_epochs} ORDER BY owner`,
              )).rows,
              ownerBefore,
            );
          }
        } finally {
          await f.close();
        }
      });
    }
  },
});
