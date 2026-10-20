import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createDatabaseAssetRepository } from "../content/database-repository.ts";
import { createMemoryBodyStore } from "../content/body-store.ts";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { CONTENT_REPLAY_RETENTION_MS } from "../content/catalog.ts";
import { isPendingContentRef } from "../content/schema.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import {
  createEventCoordinator,
  createEventStore,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/executor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
} from "../testing/effect-commit-proxy.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
type Outcome = "completed" | "failed" | "cancelled";

async function fixture(
  database: TestDatabase,
  schema = `settlement_retention_${crypto.randomUUID().replaceAll("-", "")}`,
  physical = createMemoryBodyStore(),
) {
  await provisionCopilotzSchema(database, schema);
  await provisionOperationCatalog(database, schema);
  const catalog = createOperationCatalog(database, schema);
  const store = createEventStore({
    session: database,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  const registry = createPluginRegistry({});
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "retention-fixture",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const assets = createDatabaseAssetRepository({
    coordinator,
    session: database,
    eventStore: store,
    databaseSchema: schema,
    storage: createBodyStorageRuntime({
      storage: { type: "custom", config: { store: physical } },
    }),
  });
  const command = createSchemaCommandRunner(database, schema);
  const capture = async (namespace: string, producer: string, key: string) => {
    const refs = await assets.capture({
      namespace,
      producer,
      operationKey: key,
      content: { type: "text", text: `retained:${key}` },
    });
    const reference = refs[0];
    assert(isPendingContentRef(reference));
    const { body } = await assets.catalog.resolvePending(namespace, reference);
    const head = await physical.head({ bodyId: body.copy.key });
    assertExists(head);
    assertEquals(head.state, "ready");
    return { reference, body, head };
  };
  const root = async (namespace: string) => {
    const result = await store.append({
      namespace,
      type: "retention.requested",
      payload: {},
    }, ["retention.consumer"]);
    const delivery = result.deliveries[0];
    assertExists(delivery);
    return { namespace, operationId: result.event.id, deliveryId: delivery.id };
  };
  const finish = async (
    input: Awaited<ReturnType<typeof root>>,
    outcome: Outcome,
  ) => {
    assertExists(
      await store.claimDelivery({
        id: input.deliveryId,
        owner: "retention-attempt",
        localExecution: true,
      }),
    );
    if (outcome === "failed") {
      assertEquals(
        (await store.failDelivery({
          id: input.deliveryId,
          owner: "retention-attempt",
          error: new Error("intentional terminal fixture failure"),
          retryable: false,
        }))?.status,
        "dead_letter",
      );
    } else if (outcome === "cancelled") {
      await command(
        "test.requestCancellation",
        {},
        (_, { transaction }) =>
          catalog.requestCancellation(
            transaction,
            input.namespace,
            input.operationId,
            "fixture cancellation",
          ),
      );
      assertEquals(
        (await store.cancelDelivery(input.deliveryId, "retention-attempt"))
          ?.status,
        "cancelled",
      );
    } else {
      assertEquals(
        (await store.succeedDelivery(input.deliveryId, "retention-attempt"))
          ?.status,
        "succeeded",
      );
    }
  };
  const state = async (namespace: string, pendingRef: string) => {
    const row = (await database.query<{
      expires: string;
      completed: string | null;
      state: string;
      exact_horizon: boolean;
    }>(
      `SELECT p.expires_at::text AS expires, o.completed_at::text AS completed,
         o.state, p.expires_at=o.completed_at+($3::bigint*interval '1 millisecond') AS exact_horizon
       FROM "${schema}".pending_content p
       JOIN "${schema}".copilotz_operations o
         ON o.namespace=p.namespace AND o.operation_id=p.producer
       WHERE p.namespace=$1 AND p.pending_ref=$2`,
      [namespace, pendingRef, CONTENT_REPLAY_RETENTION_MS],
    )).rows[0];
    assertExists(row);
    return row;
  };
  const ageCapture = async (
    captured: Awaited<ReturnType<typeof capture>>,
    expires: string,
  ) => {
    // Model a producer that ran longer than the original capture horizon. Only
    // fixture clocks/deadlines change: capture, terminal and physical bytes are real.
    await command("test.ageCapture", {}, async (_, { transaction }) => {
      await transaction.query(
        `UPDATE "${schema}".pending_content SET expires_at=$2 WHERE pending_ref=$1`,
        [captured.reference.pendingRef, expires],
      );
      await transaction.query(
        `UPDATE "${schema}".content_logical_bodies SET protected_until='2000-01-01' WHERE body_id=$1`,
        [captured.body.bodyId],
      );
      await transaction.query(
        `UPDATE "${schema}".content_copies SET retire_after='2000-01-01' WHERE body_id=$1`,
        [captured.body.bodyId],
      );
    });
  };
  const owner = await openDatabaseOwner(database, schema);
  return {
    database,
    schema,
    physical,
    catalog,
    assets,
    capture,
    root,
    finish,
    state,
    ageCapture,
    async close() {
      await executor.shutdown();
      owner.stop();
    },
  };
}

Deno.test({
  name:
    "PostgreSQL settlement retains captured bodies from actual completion for every terminal outcome without sliding replay protection",
  ignore: !url,
  async fn(t) {
    const db = await createTestDatabase({
      url: localPostgresUrl(url!),
      pgPoolMax: 2,
    });
    const f = await fixture(db);
    const checks: Array<{
      expires: string;
      short: Awaited<ReturnType<typeof f.capture>>;
      long: Awaited<ReturnType<typeof f.capture>>;
    }> = [];
    let next: TestDatabase | undefined;
    let recovery: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      for (const outcome of ["completed", "failed", "cancelled"] as const) {
        await t.step(outcome, async () => {
          const target = await f.root(`scope-${outcome}`);
          const short = await f.capture(
            target.namespace,
            target.operationId,
            `${outcome}:short`,
          );
          const long = await f.capture(
            target.namespace,
            target.operationId,
            `${outcome}:long`,
          );
          const longUntil = new Date(
            Date.now() + 2 * CONTENT_REPLAY_RETENTION_MS,
          ).toISOString();
          await f.ageCapture(short, "2000-01-01T00:00:00.000Z");
          await f.ageCapture(long, longUntil);
          const before = await f.state(
            target.namespace,
            short.reference.pendingRef,
          );
          const originalLong = await f.state(
            target.namespace,
            long.reference.pendingRef,
          );
          assertEquals(before.completed, null);
          // With expired logical/copy/capture clocks, the real live producer is
          // still sufficient to prevent physical collection before settlement.
          assertEquals(
            await f.assets.retireUnownedReadyBody({
              store: f.physical,
              body: short.head,
            }),
            { status: "blocked" },
          );
          await f.finish(target, outcome);
          assertEquals(await f.catalog.reconcile(target), 1);
          const committed = await f.state(
            target.namespace,
            short.reference.pendingRef,
          );
          assertEquals(committed.state, outcome);
          assertExists(committed.completed);
          assertEquals(committed.exact_horizon, true);
          assertEquals(
            (await f.state(target.namespace, long.reference.pendingRef))
              .expires,
            originalLong.expires,
          );
          assertEquals(await f.catalog.reconcile(target), 0);
          // A fresh SQL transaction has a later NOW(), so equality also catches
          // accidental deadline renewal on otherwise idempotent reconciliation.
          await db.query("SELECT pg_sleep(0.02)");
          assertEquals(await f.catalog.reconcile(target), 0);
          assertEquals(
            await f.state(target.namespace, short.reference.pendingRef),
            committed,
          );
          checks.push({ expires: committed.expires, short, long });
        });
      }
      await f.close();
      next = await createTestDatabase({
        url: localPostgresUrl(url!),
        pgPoolMax: 2,
      });
      let now = Date.now();
      const successor = await openDatabaseOwner(next, f.schema, {
        now: () => new Date(now),
      });
      recovery = await fixture(next, f.schema, f.physical);
      try {
        for (const { expires, short, long } of checks) {
          now = Date.parse(expires) - 1;
          // The new owner's trusted clock is one millisecond before the replay
          // horizon. No live producer, graph owner or logical/copy deadline can
          // mask a failure of pending-content retention at this boundary.
          assertEquals(
            await recovery.assets.retireUnownedReadyBody({
              store: f.physical,
              body: short.head,
            }),
            { status: "blocked" },
          );
          assertEquals(
            await recovery.assets.retireUnownedReadyBody({
              store: f.physical,
              body: long.head,
            }),
            { status: "blocked" },
          );
          assertExists(await f.physical.head({ bodyId: short.body.copy.key }));
        }
      } finally {
        successor.stop();
      }
    } finally {
      await recovery?.close();
      await next?.close();
      await f.close();
      await db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
      await db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL lost settlement COMMIT reply and restarted owner preserve the first pending replay deadline",
  ignore: !url,
  async fn() {
    const proxy = await commitProxy(localPostgresUrl(url!));
    const first = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    const f = await fixture(first);
    let next: TestDatabase | undefined;
    let recovery: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const target = await f.root("scope-lost-reply");
      const captured = await f.capture(
        target.namespace,
        target.operationId,
        "lost-reply",
      );
      await f.ageCapture(captured, "2000-01-01T00:00:00.000Z");
      await f.finish(target, "completed");
      const owner = await openDatabaseOwner(first, f.schema);
      proxy.arm();
      const rejected = assertRejects(() => f.catalog.reconcile(target));
      await bounded(proxy.forwarded, "settlement COMMIT forwarded");
      assertEquals(
        await bounded(proxy.resolved, "settlement COMMIT committed"),
        "COMMIT",
      );
      proxy.cutClient();
      assertEquals(
        (await bounded(rejected, "lost settlement reply") as { code?: string })
          .code,
        "owner_commit_unknown",
      );
      assertEquals(owner.state, "stopped");
      next = await createTestDatabase({
        url: localPostgresUrl(url!),
        pgPoolMax: 2,
      });
      recovery = await fixture(next, f.schema, f.physical);
      const committed = await recovery.state(
        target.namespace,
        captured.reference.pendingRef,
      );
      assertEquals(committed.state, "completed");
      assertEquals(committed.exact_horizon, true);
      const successor = await openDatabaseOwner(next, f.schema);
      assert(successor.epoch! > owner.epoch!);
      for (let retry = 0; retry < 3; retry++) {
        await next.query("SELECT pg_sleep(0.02)");
        assertEquals(await recovery.catalog.reconcile(target), 0);
        assertEquals(
          await recovery.state(target.namespace, captured.reference.pendingRef),
          committed,
        );
      }
      assertEquals(
        await recovery.assets.retireUnownedReadyBody({
          store: recovery.physical,
          body: captured.head,
        }),
        { status: "blocked" },
      );
      const restored = await recovery.assets.catalog.resolvePending(
        target.namespace,
        captured.reference,
      );
      assertEquals(restored.producer, target.operationId);
      assertEquals(restored.body.bodyId, captured.body.bodyId);
      assertEquals(proxy.errors, []);
    } finally {
      await proxy.close();
      await recovery?.close();
      await next?.query(`DROP SCHEMA "${f.schema}" CASCADE`);
      await next?.close();
      await first.close();
    }
  },
});
