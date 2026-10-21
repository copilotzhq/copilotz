import { assertEquals, assertRejects } from "@std/assert";
import { ActionOwnershipLost } from "../actions/ownership.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";
import {
  assertOwnerInvocationLive,
  type OwnerInvocationLiveness,
} from "./invocation-liveness.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test({
  name:
    "PostgreSQL shared invocation verifier keeps exact source, attempt, epoch and cancellation bindings",
  ignore: !url,
  async fn(t) {
    const db = await createTestDatabase({ url: url! });
    const schema = `invocation_live_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    const deadline = Date.UTC(2000, 0, 1);
    let time = deadline - 1;
    const owner = await openDatabaseOwner(db, schema, {
      now: () => new Date(time),
    });
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
    const run = createSchemaCommandRunner(db, schema);
    const signal = new AbortController().signal;
    try {
      const root = await store.append({
        namespace: "space",
        type: "test.root",
        payload: {},
      }, ["processor"]);
      const id = root.deliveries[0].id;
      await store.claimDelivery({ id, owner: "attempt", leaseMs: 1 });
      await db.query(
        `INSERT INTO ${store.tables.open_actions}
         (namespace,action_run_id,action_id,scope_id,invoked_event_id,state,owner_delivery_id)
         VALUES ('space','run','test.action',$1,$1,'invoked',$2)`,
        [root.event.id, id],
      );
      const binding: OwnerInvocationLiveness = {
        databaseSchema: schema,
        namespace: "space",
        operationCatalog: catalog,
        operationId: root.event.id,
        eventId: root.event.id,
        writer: { deliveryId: id, leaseOwner: "attempt" },
        action: { id: "test.action", runId: "run" },
      };
      const check = (change: Partial<OwnerInvocationLiveness> = {}) =>
        run(
          "test.invocation",
          {},
          (_, command) =>
            assertOwnerInvocationLive(command, { ...binding, ...change }),
        );
      await t.step(
        "captured earlier, equality and later boundaries",
        async () => {
          await check();
          time = deadline;
          await assertRejects(() => check(), ActionOwnershipLost);
          time = deadline + 1;
          await assertRejects(() => check(), ActionOwnershipLost);
          time = deadline - 1;
        },
      );
      await t.step(
        "exact attempt, event, operation, Action and epoch",
        async () => {
          for (
            const changed of [
              { writer: { deliveryId: id, leaseOwner: "stale-attempt" } },
              {
                writer: { deliveryId: "other-delivery", leaseOwner: "attempt" },
              },
              { eventId: "other-event" },
              { operationId: "other-operation" },
              { action: { id: "other-action", runId: "run" } },
              { action: { id: "test.action", runId: "other-run" } },
              { namespace: "other-space" },
              { namespace: "other-space", action: undefined },
            ]
          ) await assertRejects(() => check(changed), ActionOwnershipLost);
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET owner_epoch=0 WHERE id=$1`,
            [id],
          );
          await assertRejects(() => check(), ActionOwnershipLost);
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET owner_epoch=$2 WHERE id=$1`,
            [id, owner.epoch],
          );
          await check();
          await assertRejects(
            () => check({ operationCatalog: undefined }),
            TypeError,
            "requires its catalog",
          );
        },
      );
      await t.step(
        "committed cancellation wins before signal propagation",
        async () => {
          const operations = createOperationCatalogTables(schema).operations;
          await db.query(
            `UPDATE ${operations} SET cancellation_requested_at=NOW() WHERE operation_id=$1`,
            [root.event.id],
          );
          assertEquals(signal.aborted, false);
          await assertRejects(() => check(), ActionOwnershipLost);
          assertEquals(signal.aborted, false);
          await db.query(
            `UPDATE ${operations} SET cancellation_requested_at=NULL WHERE operation_id=$1`,
            [root.event.id],
          );
        },
      );
      await t.step(
        "local NULL deadlines stay live; closed Actions do not regain mutation authority",
        async () => {
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET lease_expires_at=NULL WHERE id=$1`,
            [id],
          );
          time = Date.UTC(2100, 0, 1);
          await check();
          await db.query(
            `DELETE FROM ${store.tables.open_actions} WHERE namespace='space' AND action_run_id='run'`,
          );
          await assertRejects(() => check(), ActionOwnershipLost);
          // The live parent remains eligible to authorize a retained child's result.
          await check({ action: undefined });
        },
      );
    } finally {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
