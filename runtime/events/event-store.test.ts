import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventStore,
  createSqlSession,
  type EventStore,
  isEventStoreError,
  type SqlSession,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_event_native";

type Fixture = {
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
};

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
    await session.query(statement);
  }
  return {
    db,
    session,
    store: createEventStore({
      session,
      schema: TEST_SCHEMA,
      random: () => 0,
    }),
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.db.close();
}

async function failThreeTimes(
  store: EventStore,
  deliveryId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const owner = `owner-${attempt}`;
    assertExists(
      await store.claimDelivery({ id: deliveryId, owner, leaseMs: 60_000 }),
    );
    await store.failDelivery({
      id: deliveryId,
      owner,
      error: new Error(`failure-${attempt}`),
      backoffMs: 0,
    });
  }
}

Deno.test("A20 clean v3 baseline contains only the four core tables", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [TEST_SCHEMA],
    );
    assertEquals(
      result.rows.map((row) => row.table_name),
      ["edges", "event_deliveries", "events", "nodes"],
    );

    const columns = await fixture.session.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'events'`,
      [TEST_SCHEMA],
    );
    assertEquals(
      columns.rows.some((row) => row.column_name === "status"),
      false,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A20 graph mutation, immutable event, and sparse deliveries commit atomically", async () => {
  const fixture = await createFixture();
  const { store, session } = fixture;
  try {
    await assertRejects(() =>
      store.commitMutation({
        draft: {
          type: "widget.created",
          namespace: "tenant-a",
          payload: { id: "rollback" },
        },
        consumerIds: ["widget.index"],
        mutate: async ({ transaction, tables }) => {
          await transaction.query(
            `INSERT INTO ${tables.nodes} (
              id, namespace, type, name, data
            ) VALUES ('rollback', 'tenant-a', 'widget', 'rollback', '{}')`,
          );
          throw new Error("synthetic mutation failure");
        },
      })
    );
    const rolledBack = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${store.tables.nodes}
       WHERE id = 'rollback'`,
    );
    assertEquals(Number(rolledBack.rows[0]?.count), 0);
    assertEquals(await store.listEvents({ namespace: "tenant-a" }), []);

    await session.query(
      `INSERT INTO ${store.tables.nodes} (
        id, namespace, type, name, data
      ) VALUES ('thread-a', 'tenant-a', 'thread', 'Thread A', '{}')`,
    );
    let mutationCalls = 0;
    const draft = {
      type: "widget.created",
      namespace: "tenant-a",
      threadId: "thread-a",
      subject: { type: "widget", id: "widget-a" },
      payload: { label: "A", nested: { second: 2, first: 1 } },
      correlationId: "correlation-a",
      deduplicationId: "widget:create:a",
    } as const;
    const first = await store.commitMutation({
      draft,
      consumerIds: ["widget.index", "widget.audit", "widget.index"],
      mutate: async ({ transaction, tables }) => {
        mutationCalls++;
        await transaction.query(
          `INSERT INTO ${tables.nodes} (
            id, namespace, type, name, data
          ) VALUES ('widget-a', 'tenant-a', 'widget', 'A', '{}')`,
        );
        return { id: "widget-a" };
      },
      recoverDuplicate: () => Promise.resolve({ id: "widget-a" }),
    });
    const replay = await store.commitMutation({
      draft: {
        ...draft,
        payload: { nested: { first: 1, second: 2 }, label: "A" },
      },
      consumerIds: ["widget.audit", "widget.index"],
      mutate: () => {
        mutationCalls++;
        return Promise.resolve({ id: "must-not-run" });
      },
      recoverDuplicate: () => Promise.resolve({ id: "widget-a" }),
    });

    assertEquals(mutationCalls, 1);
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, first.event.id);
    assertEquals(first.deliveries.length, 2);
    assert(Object.isFrozen(first.event));
    assert(Object.isFrozen(first.event.payload));

    const thread = await session.query<{
      data: Record<string, unknown>;
    }>(
      `SELECT data FROM ${store.tables.nodes} WHERE id = 'thread-a'`,
    );
    assertEquals(thread.rows[0]?.data?.lastEventId, first.event.id);
    assertEquals(
      String(thread.rows[0]?.data?.lastEventPosition),
      first.event.position,
    );

    const conflict = await assertRejects(() =>
      store.append({
        ...draft,
        payload: { label: "different" },
      }, ["widget.index"])
    );
    assert(isEventStoreError(conflict));
    assertEquals(conflict.code, "event_deduplication_conflict");

    await assertRejects(() =>
      session.query(
        `UPDATE ${store.tables.events} SET type = 'widget.changed'
         WHERE id = $1`,
        [first.event.id],
      )
    );
    assertEquals(
      (await store.getEvent(first.event.id))?.type,
      "widget.created",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A47 positions, tenant isolation, and passive events do not multiply deliveries", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const passive = await store.append({
      type: "message.created",
      namespace: "tenant-a",
      payload: "123",
    });
    const actionable = await store.append({
      type: "message.created",
      namespace: "tenant-a",
      payload: { content: "work" },
    }, ["agent.router", "agent.router", "memory.observe"]);
    await store.append({
      type: "message.created",
      namespace: "tenant-b",
      payload: { content: "private" },
    }, ["agent.router"]);

    assertEquals(passive.deliveries, []);
    assertEquals((await store.getEvent(passive.event.id))?.payload, "123");
    assertEquals(actionable.deliveries.length, 2);
    assert(Number(actionable.event.position) > Number(passive.event.position));
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a" })).length,
      2,
    );
    assertEquals(
      (await store.listEvents({ namespace: "tenant-b" })).length,
      1,
    );
    assertEquals(
      (await store.listDeliveries({ namespace: "tenant-a" })).length,
      2,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A22 delivery claims retry three times, dead-letter, retry, and discard", async () => {
  const fixture = await createFixture();
  const store = createEventStore({
    session: fixture.session,
    schema: TEST_SCHEMA,
    random: () => 0.5,
    retryBaseMs: 30_000,
    retryCapMs: 30_000,
  });
  try {
    const committed = await store.append({
      type: "work.created",
      namespace: "tenant-a",
      payload: {},
      correlationId: "retry-scope",
    }, ["worker"]);
    const id = committed.deliveries[0].id;

    const first = await store.claimDelivery({
      id,
      owner: "owner-1",
      leaseMs: 60_000,
    });
    assertEquals(first?.attempts, 1);
    assertEquals(await store.succeedDelivery(id, "wrong-owner"), false);
    assertEquals(
      await store.heartbeatDelivery({
        id,
        owner: "owner-1",
        leaseMs: 60_000,
      }),
      true,
    );
    const retry = await store.failDelivery({
      id,
      owner: "owner-1",
      error: new Error("failure-1"),
    });
    assertEquals(retry?.status, "retry_wait");
    assert(
      new Date(retry!.availableAt).getTime() - Date.now() > 10_000,
      "injected half-jitter should schedule an exponential retry in the future",
    );
    await fixture.session.query(
      `UPDATE ${store.tables.event_deliveries}
       SET available_at = NOW() WHERE id = $1`,
      [id],
    );
    for (let attempt = 2; attempt <= 3; attempt++) {
      const owner = `owner-${attempt}`;
      assertEquals(
        (await store.claimDelivery({ id, owner, leaseMs: 60_000 }))?.attempts,
        attempt,
      );
      const failed = await store.failDelivery({
        id,
        owner,
        error: `failure-${attempt}`,
        backoffMs: 0,
      });
      assertEquals(
        failed?.status,
        attempt === 3 ? "dead_letter" : "retry_wait",
      );
    }
    assertEquals(
      await store.scopeSettlement("tenant-a", committed.event.id),
      { unsettled: 0, deadLetters: 1, cancelled: 0, succeeded: 0 },
    );

    assertEquals(await store.retryDeadLetter(id), true);
    assertEquals((await store.getDelivery(id))?.attempts, 0);
    await failThreeTimes(store, id);
    assertEquals(await store.discardDeadLetter(id), true);
    assertEquals((await store.getDelivery(id))?.status, "cancelled");
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A21 crash recovery and concurrent claims preserve one delivery owner", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const committed = await store.append({
      type: "work.created",
      namespace: "tenant-a",
      payload: {},
    }, ["worker"]);
    const id = committed.deliveries[0].id;
    assertEquals((await store.listRecoverable()).map((item) => item.id), [id]);

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimDelivery({
          id,
          owner: `concurrent-${index}`,
          leaseMs: 60_000,
        })),
    );
    assertEquals(claims.filter(Boolean).length, 1);
    const owner = claims.find((claim) => claim)?.leaseOwner;
    assertExists(owner);
    assertEquals(await store.succeedDelivery(id, owner), true);

    const high = await store.append(
      {
        type: "priority.high",
        namespace: "tenant-a",
        payload: {},
      },
      ["worker"],
      { priority: 10 },
    );
    await store.append(
      {
        type: "priority.low",
        namespace: "tenant-a",
        payload: {},
      },
      ["worker"],
      { priority: 1 },
    );
    assertEquals(
      (await store.claimNext({
        owner: "next",
        namespace: "tenant-a",
        consumerIds: ["worker"],
        leaseMs: 0,
      }))?.id,
      high.deliveries[0].id,
    );
    assertEquals(
      (await store.claimDelivery({
        id: high.deliveries[0].id,
        owner: "replacement",
        leaseMs: 60_000,
      }))?.attempts,
      2,
    );

    const exhausted = await store.append(
      {
        type: "lease.crashed",
        namespace: "tenant-a",
        payload: {},
      },
      ["worker"],
      { maxAttempts: 2 },
    );
    const exhaustedId = exhausted.deliveries[0].id;
    await store.claimDelivery({ id: exhaustedId, owner: "gone-1", leaseMs: 0 });
    await store.claimDelivery({ id: exhaustedId, owner: "gone-2", leaseMs: 0 });
    await store.listRecoverable();
    assertEquals((await store.getDelivery(exhaustedId))?.status, "dead_letter");

    const source = await store.append({
      type: "tool_execution.created",
      namespace: "tenant-a",
      payload: { callId: "call-a" },
    }, ["tool.execute"]);
    await store.claimDelivery({
      id: source.deliveries[0].id,
      owner: "crashed-after-output",
      leaseMs: 0,
    });
    const outputDraft = {
      type: "tool_execution.completed",
      namespace: "tenant-a",
      payload: { callId: "call-a", result: "once" },
      causationId: source.event.id,
      correlationId: source.event.correlationId,
      deduplicationId: `tool-output:${source.event.id}`,
    } as const;
    const output = await store.append(outputDraft);
    const replayedOutput = await store.append(outputDraft);
    assertEquals(replayedOutput.deduplicated, true);
    assertEquals(replayedOutput.event.id, output.event.id);
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a" })).filter((event) =>
        event.deduplicationId === outputDraft.deduplicationId
      ).length,
      1,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A23 settlement and cancellation follow causation, not shared correlation", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const root = await store.append({
      type: "message.created",
      namespace: "tenant-a",
      payload: {},
      correlationId: "shared-correlation",
    }, ["router"]);
    const child = await store.append({
      type: "llm_attempt.created",
      namespace: "tenant-a",
      payload: {},
      causationId: root.event.id,
      correlationId: "shared-correlation",
    }, ["llm"]);
    const grandchild = await store.append({
      type: "tool_execution.created",
      namespace: "tenant-a",
      payload: {},
      causationId: child.event.id,
      correlationId: "shared-correlation",
    }, ["tool"]);
    const unrelated = await store.append({
      type: "scheduled_job.created",
      namespace: "tenant-a",
      payload: {},
      correlationId: "shared-correlation",
    }, ["scheduler"]);

    for (const delivery of [root.deliveries[0], child.deliveries[0]]) {
      const owner = `owner-${delivery.id}`;
      await store.claimDelivery({ id: delivery.id, owner });
      await store.succeedDelivery(delivery.id, owner);
    }
    assertEquals(
      await store.scopeSettlement("tenant-a", root.event.id),
      { unsettled: 1, deadLetters: 0, cancelled: 0, succeeded: 2 },
    );
    assertEquals(
      await store.cancelScope("tenant-a", root.event.id, "user stopped"),
      1,
    );
    assertEquals(
      (await store.getDelivery(grandchild.deliveries[0].id))?.status,
      "cancelled",
    );
    assertEquals(
      (await store.getDelivery(unrelated.deliveries[0].id))?.status,
      "pending",
    );
    assertEquals(
      await store.scopeSettlement("tenant-a", root.event.id),
      { unsettled: 0, deadLetters: 0, cancelled: 1, succeeded: 2 },
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A22 compaction removes only old fully settled semantic work", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const old = "2020-01-01T00:00:00.000Z";
    const settled = await store.append({
      type: "old.settled",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    }, ["consumer"]);
    const settledId = settled.deliveries[0].id;
    await store.claimDelivery({ id: settledId, owner: "settled" });
    await store.succeedDelivery(settledId, "settled");

    const passive = await store.append({
      type: "old.passive",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    });
    const dead = await store.append({
      type: "old.dead",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    }, ["consumer"]);
    await failThreeTimes(store, dead.deliveries[0].id);
    const pending = await store.append({
      type: "old.pending",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    }, ["consumer"]);

    assertEquals(
      await store.compact({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
      }),
      { events: 2, deliveries: 1 },
    );
    assertEquals(await store.getEvent(settled.event.id), null);
    assertEquals(await store.getEvent(passive.event.id), null);
    assertEquals(
      (await store.getDelivery(dead.deliveries[0].id))?.status,
      "dead_letter",
    );
    assertEquals(
      (await store.getDelivery(pending.deliveries[0].id))?.status,
      "pending",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 event core is runtime-neutral and factory-first", async () => {
  for (
    const module of [
      "errors.ts",
      "index.ts",
      "schema.ts",
      "session.ts",
      "store.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b/.test(source), `${module} accesses Deno`);
    assert(!/\bBun\b/.test(source), `${module} accesses Bun`);
    assert(!/\bprocess\b/.test(source), `${module} accesses process`);
    assert(!/from\s+["']node:/.test(source), `${module} imports node APIs`);
    assert(!/\bclass\s+\w+/.test(source), `${module} introduces a class`);
    assert(
      !/runtime\/cli|server\//.test(source),
      `${module} imports a runtime adapter`,
    );
  }
});
