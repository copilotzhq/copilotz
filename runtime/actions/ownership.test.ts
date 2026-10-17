import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
} from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { ActionOwnershipLost, actionOwnershipStatement } from "./ownership.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";

async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    const store = createEventStore({ session: db });
    const root = await store.append({
      type: "source",
      namespace: "space",
      payload: {},
    }, ["consumer"]);
    const delivery = root.deliveries[0];
    assert.ok(
      await store.claimDelivery({
        id: delivery.id,
        owner: "unique-attempt",
        leaseMs: 60_000,
      }),
    );
    const coordinator = createEventCoordinator({
      store,
      registry: createPluginRegistry({ plugins: [] }),
      executor: {
        scheduleDelivery() {
          assert.fail("No fixture consumers");
        },
      } as never,
    });
    const lifecycle = (runId: string, commandTime?: string) =>
      db.transaction(async (transaction) => {
        const emitter = createActionLifecycleEmitter({
          namespace: "space",
          append: createActionLifecycleAppender({
            store,
            coordinator,
            writer: {
              kind: "delivery",
              deliveryId: delivery.id,
              leaseOwner: "unique-attempt",
            },
            transaction,
            ...(commandTime === undefined ? {} : { commandTime }),
          }),
        });
        return await emitter.emit({
          actionRunId: runId,
          actionId: "work",
          status: "invoked",
          input: null,
          metadata: {},
          deduplicationId: `${runId}:action:invoked`,
          settlementScopeId: root.event.id,
        });
      });
    const expires = (time: string) =>
      db.query(
        `UPDATE ${store.tables.event_deliveries} SET lease_expires_at = $1 WHERE id = $2`,
        [time, delivery.id],
      );
    return { db, store, lifecycle, expires };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test("Action ownership uses captured owner command time rather than the earlier database clock", async () => {
  const f = await fixture();
  try {
    await f.expires("2099-01-01T00:00:00.000Z");
    await assert.rejects(
      f.lifecycle("expired", "2099-01-01T00:00:00.001Z"),
      ActionOwnershipLost,
    );
    await assert.rejects(
      f.lifecycle("equal", "2099-01-01T00:00:00.000Z"),
      ActionOwnershipLost,
    );
    assert.equal((await f.db.query("SELECT * FROM events")).rows.length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM event_bodies")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("Action ownership admits a lease valid at captured time even when database NOW is later", async () => {
  const f = await fixture();
  try {
    await f.expires("2000-01-01T00:01:00.000Z");
    const result = await f.lifecycle("captured", "2000-01-01T00:00:00.000Z");
    assert.ok("deduplicated" in result);
    assert.equal(result.deduplicated, false);
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM event_bodies")).rows.length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test("Action ownership retains the legacy database clock default", async () => {
  const f = await fixture();
  try {
    await f.expires("2099-01-01T00:00:00.000Z");
    const live = await f.lifecycle("live");
    assert.ok("deduplicated" in live);
    assert.equal(live.deduplicated, false);
    await f.expires("2000-01-01T00:00:00.000Z");
    await assert.rejects(f.lifecycle("expired-legacy"), ActionOwnershipLost);
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

const statementInput: ActionLifecycleAppendInput = {
  draft: {
    type: "work.invoked",
    namespace: "space",
    deduplicationId: "run:action:invoked",
  },
  data: {
    actionId: "work",
    actionRunId: "run",
    status: "invoked",
    input: null,
    metadata: {},
  },
};
const statementWriter = {
  kind: "delivery",
  deliveryId: "delivery",
  leaseOwner: "attempt",
} as const;

test("Action ownership binds commandTime as data and keeps legacy/recovery statements unchanged", () => {
  const params: unknown[] = [];
  const captured = "2099-01-01T00:00:00.000Z";
  const make = (
    time?: string,
    writer = statementWriter as Parameters<typeof actionOwnershipStatement>[1],
  ) => {
    params.length = 0;
    return actionOwnershipStatement(
      statementInput,
      writer,
      createCoreTableNames(),
      (value) => `$${params.push(value)}`,
      time,
    );
  };
  const timed = make(captured).ctes.join("\n");
  assert.ok(
    timed.includes(
      `lease_expires_at > $${params.indexOf(captured) + 1}::timestamptz`,
    ),
  );
  assert.equal(timed.includes(captured), false);
  assert.equal(timed.includes("NOW()"), false);
  assert.ok(make().ctes.join("\n").includes("lease_expires_at > NOW()"));
  const recovery = { kind: "recovery", deliveryId: "delivery" } as const;
  assert.deepEqual(
    make(captured, recovery).ctes,
    make(undefined, recovery).ctes,
  );
});

test("Action commandTime validation rejects malformed clocks before SQL or body preparation", () => {
  for (
    const value of [
      "",
      "not-a-timestamp",
      "infinity",
      "2099-01-01'; SELECT 1; --",
      null,
      123,
    ]
  ) {
    let parameters = 0;
    assert.throws(
      () =>
        actionOwnershipStatement(
          statementInput,
          statementWriter,
          createCoreTableNames(),
          () => {
            parameters++;
            return "$1";
          },
          value as string,
        ),
      /valid timestamp/,
    );
    assert.equal(parameters, 0);
    let coordinatorCalls = 0;
    assert.throws(() =>
      createActionLifecycleAppender({
        coordinator: {
          commitMutation() {
            coordinatorCalls++;
            throw new Error("SQL must not run");
          },
        } as never,
        commandTime: value as string,
      }), /valid timestamp/);
    assert.equal(coordinatorCalls, 0);
  }
});
