import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/definition.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerCommandBoundary } from "./boundary.ts";
import {
  createOwnerCollectionCommand,
  type OwnerCollectionScope,
} from "./collections.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

test("owner Collection catalog commits actual detached Processor scope and rolls it back with the outer command", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let rollback = false;
  const session: SqlSession = {
    query: db.query,
    transaction: (callback) =>
      db.transaction(async (tx) => {
        const value = await callback(tx);
        if (rollback) throw new Error("injected outer rollback");
        return value;
      }),
  };
  const scheduled: string[] = [];
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "unused",
    workloads: {},
    scheduleDelivery(delivery) {
      scheduled.push(typeof delivery === "string" ? delivery : delivery.id);
    },
    dispatchWork() {
      throw new Error("direct dispatch is forbidden");
    },
    dispatchDelivery() {
      throw new Error("direct dispatch is forbidden");
    },
    dispatchRecoverable() {
      throw new Error("recovery is not this fixture");
    },
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const notes = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
    } as const,
  });
  const registry = createPluginRegistry({
    collections: { notes },
    processors: {
      detached: defineProcessor({
        id: "fixture.detached",
        on: [{ eventType: "note.created" }],
        settlement: "detached",
        handle() {
          throw new Error("only postcommit references are scheduled");
        },
      }),
    },
  });
  let boundary: ReturnType<typeof createOwnerCommandBoundary> | undefined;
  try {
    await provisionCopilotzSchema(session, "public");
    await provisionOperationCatalog(session, "public");
    await provisionOwnerCommandSchema(session, "public");
    const catalog = createOperationCatalog(session, "public");
    const scopes = new WeakMap<SqlExecutor, OwnerCollectionScope>();
    assert.throws(() =>
      createOwnerCollectionCommand({
        session,
        schema: "other",
        registry,
        collections: registry.collections,
        executor,
        catalog,
        scope: () => ({ namespace: "space" }),
      }), /catalog schema/);
    const command = createOwnerCollectionCommand({
      session,
      schema: "public",
      registry,
      collections: registry.collections,
      executor,
      catalog,
      scope: (context) => scopes.get(context.tx)!,
    });
    const makeBoundary = () =>
      createOwnerCommandBoundary({
        ownerId: "owner",
        holderId: "holder",
        session,
        schema: "public",
        handlers: {
          collections: async (intent, context) => {
            // Establish the real parent operation through an owner-created root
            // event, as Action/Processor callers do. Never insert a synthetic scope.
            const store = createEventStore({
              session,
              schema: "public",
              ownerCommit: context.ownerCommit,
              admitOperationEventSql: catalog.admitEventSql,
              indexOperationEvent: catalog.indexEvent,
              indexOperationEventSql: catalog.indexEventSql,
            });
            const root = await store.commitMutation({
              transaction: context.tx,
              draft: {
                namespace: "space",
                type: "fixture.root",
                payload: {},
                deduplicationId: `root:${context.command.key}`,
              },
              consumers: [],
            });
            scopes.set(context.tx, {
              namespace: "space",
              identity: {
                causationId: root.event.id,
                correlationId: root.event.correlationId,
                settlementScopeId: root.settlementScopeId,
              },
            });
            return await command(intent, context);
          },
        },
        authorize(_tx, caller) {
          assert.equal(caller.workerId, "fixture");
        },
        authenticateReceipt() {
          throw new Error("Receipt lookup is not part of this fixture.");
        },
      });
    boundary = makeBoundary();
    let ownerEpoch = await boundary.acquire(0);
    const create = (id: string) =>
      boundary!.execute({
        workerId: "fixture",
        ownerEpoch,
      }, {
        kind: "collections",
        domain: "logical",
        key: id,
        intent: {
          operations: [{
            collection: "notes",
            operation: "create",
            input: { id, title: id },
          }],
        },
      });
    rollback = true;
    await assert.rejects(create("rolled-back"), /outcome is unknown/);
    assert.equal(boundary.state, "stopped");
    rollback = false;
    assert.deepEqual(scheduled, []);
    for (
      const table of [
        "nodes",
        "events",
        "event_deliveries",
        "copilotz_operations",
        "owner_receipts",
      ]
    ) {
      assert.equal(
        (await db.query(`SELECT 1 FROM ${table}`)).rows.length,
        0,
        table,
      );
    }
    // The injected SQL transaction has definitively rolled back. A fresh fenced
    // boundary is required; the stopped holder must never resume itself.
    boundary = makeBoundary();
    ownerEpoch = await boundary.acquire(ownerEpoch);
    const first = await create("committed");
    assert.equal(first.status, "committed");
    const deliveries = await db.query<{
      id: string;
      event_id: string;
      settlement_scope_id: string;
      consumer_id: string;
    }>(
      "SELECT id,event_id,settlement_scope_id,consumer_id FROM event_deliveries",
    );
    assert.equal(deliveries.rows.length, 1);
    const delivery = deliveries.rows[0];
    assert.equal(delivery.consumer_id, "processor:fixture.detached");
    assert.notEqual(delivery.settlement_scope_id, delivery.event_id);
    const operation = await catalog.get("space", delivery.settlement_scope_id);
    assert.ok(
      operation,
      "actual detached delivery must have an indexed catalog operation",
    );
    assert.equal(operation.state, "accepted");
    assert.equal(
      (await db.query(
        "SELECT visibility FROM copilotz_operations WHERE operation_id=$1",
        [delivery.settlement_scope_id],
      )).rows[0].visibility,
      "internal",
    );
    assert.equal(operation.rootEventId, delivery.event_id);
    const source = (await db.query<{ causation_id: string }>(
      "SELECT causation_id FROM events WHERE id=$1",
      [delivery.event_id],
    )).rows[0];
    assert.equal(
      (await catalog.listOperationEventIds({
        namespace: "space",
        operationId: source.causation_id,
      })).some(
        (entry) => entry.eventId === delivery.event_id,
      ),
      true,
    );
    assert.equal(
      (await db.query(
        "SELECT title FROM (SELECT data->>'title' title FROM nodes) n",
      )).rows[0].title,
      "committed",
    );
    assert.equal(
      (await db.query("SELECT COUNT(*)::int count FROM owner_receipts")).rows[0]
        .count,
      1,
    );
    assert.deepEqual(
      (await db.query("SELECT seq FROM events ORDER BY seq")).rows.map((row) =>
        String(row.seq)
      ),
      ["1", "2"],
    );
    for (let attempt = 0; scheduled.length === 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(scheduled, [delivery.id]);
    assert.equal((await create("committed")).status, "duplicate");
    assert.deepEqual(scheduled, [delivery.id]);
  } finally {
    boundary?.stop();
    await db.close();
  }
});
