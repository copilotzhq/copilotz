import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
  createEventStore,
  createSqlSession,
  type EventStore,
  isEventStoreError,
  provisionCopilotzSchema,
  type SqlSession,
  validateCopilotzSchema,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_event_native";

type Fixture = {
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
};

async function createFixture(
  url = ":memory:",
  schema = TEST_SCHEMA,
): Promise<Fixture> {
  const db = await createTestDatabase({ url });
  const session = createSqlSession(db);
  await provisionCopilotzSchema(session, schema);
  return {
    db,
    session,
    store: createEventStore({
      session,
      schema,
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

Deno.test("A20 clean v5 baseline contains the marker and no body-reference table", async () => {
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
      [
        "copilotz_schema_metadata",
        "edges",
        "event_bodies",
        "event_deliveries",
        "events",
        "nodes",
      ],
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
    const bodyReferences = await fixture.session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'body_references'`,
      [TEST_SCHEMA],
    );
    assertEquals(bodyReferences.rows, []);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("normal provisioning refuses a released v3 schema without writing current tables", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_released_v3_refusal";
  try {
    await session.query(`CREATE SCHEMA "${schema}"`);
    // Literal released-v3 shape: no marker and no event_bodies table.
    await session.query(
      `CREATE TABLE "${schema}"."events" (
        position BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        namespace TEXT NOT NULL,
        payload JSONB NOT NULL,
        routing JSONB NOT NULL DEFAULT '{}'::jsonb,
        visibility JSONB NOT NULL DEFAULT '{"kind":"public"}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        correlation_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await assertRejects(
      () => provisionCopilotzSchema(session, schema),
      Error,
      "is incompatible with this release",
    );
    const tables = await session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    assertEquals(tables.rows.map((row) => row.table_name), ["events"]);
  } finally {
    await db.close();
  }
});

Deno.test("atomic provisioning creates and validates a fresh v5 marker", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_fresh_v4_marker";
  try {
    assertEquals((await provisionCopilotzSchema(session, schema)).version, 5);
    const marker = await session.query<{ version: number }>(
      `SELECT version FROM "${schema}"."copilotz_schema_metadata"`,
    );
    assertEquals(marker.rows, [{ version: 5 }]);
    assertEquals((await provisionCopilotzSchema(session, schema)).version, 5);
  } finally {
    await db.close();
  }
});

Deno.test("direct validation rejects an incompatible schema marker", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "copilotz_incompatible_marker";
  try {
    await provisionCopilotzSchema(db, schema);
    await db.query(
      `UPDATE "${schema}"."copilotz_schema_metadata" SET version=4`,
    );
    await assertRejects(
      () => validateCopilotzSchema(db, schema),
      Error,
      "Use a fresh schema",
    );
    await assertRejects(
      () => provisionCopilotzSchema(db, schema),
      Error,
      "incompatible",
    );
    const marker = await db.query<{ version: number }>(
      `SELECT version FROM "${schema}"."copilotz_schema_metadata"`,
    );
    assertEquals(marker.rows[0].version, 4);
  } finally {
    await db.close();
  }
});

Deno.test("schema provisioning contains no operational tool-execution indexes", async () => {
  const fixture = await createFixture();
  try {
    const indexes = await fixture.session.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN ('nodes_tool_call_idx', 'nodes_tool_call_unique_idx')
       ORDER BY indexname`,
      [TEST_SCHEMA],
    );
    assertEquals(indexes.rows, []);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("schema provisioning backfills legacy deliveries to their causal root scope", async () => {
  const fixture = await createFixture();
  try {
    const root = await fixture.store.append({
      type: "legacy.root",
      namespace: "tenant-a",
      payload: {},
    }, ["root"]);
    const child = await fixture.store.append({
      type: "legacy.child",
      namespace: "tenant-a",
      payload: {},
      causationId: root.event.id,
      correlationId: root.event.correlationId,
    }, ["child"]);
    await fixture.session.query(
      `ALTER TABLE ${fixture.store.tables.event_deliveries}
       DROP COLUMN settlement_scope_id`,
    );
    for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
      await fixture.session.query(statement);
    }
    const rows = await fixture.session.query<{
      id: string;
      settlement_scope_id: string;
    }>(
      `SELECT id, settlement_scope_id
       FROM ${fixture.store.tables.event_deliveries}
       ORDER BY id`,
    );
    assertEquals(
      rows.rows.map((row) => row.settlement_scope_id),
      [root.event.id, root.event.id],
    );
    assertExists(await fixture.store.getDelivery(child.deliveries[0].id));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("schema provisioning scopes legacy backfill to deliveries missing a scope", () => {
  const statement = createCoreSchemaStatements(TEST_SCHEMA).find((candidate) =>
    candidate.includes("WITH RECURSIVE ancestry")
  );
  assertExists(statement);
  assertStringIncludes(
    statement,
    `FROM ${createCoreTableNames(TEST_SCHEMA).event_deliveries} AS delivery`,
  );
  assertStringIncludes(statement, "WHERE delivery.settlement_scope_id IS NULL");
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
        consumers: [{ consumerId: "widget.index", settlement: "inherit" }],
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
      consumers: [
        { consumerId: "widget.index", settlement: "inherit" },
        { consumerId: "widget.audit", settlement: "inherit" },
        { consumerId: "widget.index", settlement: "inherit" },
      ],
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
      consumers: [
        { consumerId: "widget.audit", settlement: "inherit" },
        { consumerId: "widget.index", settlement: "inherit" },
      ],
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
      (await store.listEvents({
        namespace: "tenant-a",
        order: "desc",
        limit: 1,
      }))[0]?.id,
      actionable.event.id,
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

Deno.test("events this store committed are read back without a query", async () => {
  const fixture = await createFixture();
  let statements = 0;
  const counted: SqlSession = {
    query: (sql, params) => {
      statements++;
      return fixture.session.query(sql, params);
    },
    transaction: (operation) => fixture.session.transaction(operation),
  };
  const store = createEventStore({ session: counted, schema: TEST_SCHEMA });
  const draft = (id: string) => ({
    type: "note.created",
    namespace: "tenant-a",
    payload: { ref: id },
    deduplicationId: id,
  });
  try {
    const committed = await store.commitMutation({
      draft: draft("note-1"),
      consumers: [],
      body: { id: "body-1", json: { text: "hello" } },
    });
    statements = 0;
    const read = await store.getEvent(committed.event.id);
    assertEquals(statements, 0);
    assertEquals(read, await fixture.store.getEvent(committed.event.id));
    (read!.payload as Record<string, unknown>).ref = "changed";
    assertEquals(
      (await store.getEvent(committed.event.id))!.payload,
      { ref: "note-1" },
    );
    assertEquals(
      store.recentEventBody?.(committed.event.id, "body-1")?.json,
      { text: "hello" },
    );
    assertEquals(
      store.recentEventBody?.(committed.event.id, "body-2"),
      undefined,
    );

    // A joined transaction's event is only remembered once confirmed.
    const joined = await fixture.session.transaction((transaction) =>
      store.commitMutation({
        draft: draft("note-2"),
        consumers: [],
        transaction,
      })
    );
    statements = 0;
    assertExists(await store.getEvent(joined.event.id));
    assertEquals(statements, 1);
    store.confirmCommitted?.(joined.event.id);
    statements = 0;
    assertExists(await store.getEvent(joined.event.id));
    assertEquals(statements, 0);

    let rolledBackId = "";
    await assertRejects(() =>
      fixture.session.transaction(async (transaction) => {
        rolledBackId = (await store.commitMutation({
          draft: draft("note-3"),
          consumers: [],
          transaction,
        })).event.id;
        throw new Error("rollback");
      })
    );
    assertEquals(await store.getEvent(rolledBackId), null);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("an event with only a body commits as one statement and dedupes on retry", async () => {
  const fixture = await createFixture();
  const statements: string[] = [];
  let transactions = 0;
  const counted: SqlSession = {
    query: (sql, params) => {
      statements.push(sql);
      return fixture.session.query(sql, params);
    },
    transaction: (operation) => {
      transactions++;
      return fixture.session.transaction(operation);
    },
  };
  const store = createEventStore({ session: counted, schema: TEST_SCHEMA });
  const tables = createCoreTableNames(TEST_SCHEMA);
  const commit = (json: unknown) =>
    store.commitMutation({
      draft: {
        type: "note.created",
        namespace: "tenant-a",
        payload: { ref: "body-1" },
        deduplicationId: "note-1",
      },
      consumers: [{ consumerId: "note.reader", settlement: "inherit" }],
      body: { id: "body-1", json },
    });
  try {
    const first = await commit({ text: "hello" });
    assertEquals(statements.length, 1);
    assertEquals(transactions, 0);
    assertEquals(first.deduplicated, false);
    assertEquals(first.deliveries.length, 1);

    const retry = await commit({ text: "hello" });
    assertEquals(retry.deduplicated, true);
    assertEquals(retry.event.id, first.event.id);
    assertEquals(retry.deliveries.map((d) => d.id), [first.deliveries[0].id]);
    const bodies = await fixture.session.query<{ body: unknown }>(
      `SELECT body FROM ${tables.event_bodies} WHERE event_body_id = 'body-1'`,
    );
    assertEquals(bodies.rows.map((row) => row.body), [{ text: "hello" }]);

    // A stray body row under a new event's body id aborts the whole commit.
    await fixture.session.query(
      `INSERT INTO ${tables.event_bodies}
         (namespace, event_body_id, schema_version, body, digest, created_at)
       VALUES ('tenant-a', 'body-2', 1, '{"text":"stale"}'::jsonb, 'x', NOW())`,
    );
    await assertRejects(
      () =>
        store.commitMutation({
          draft: {
            type: "note.created",
            namespace: "tenant-a",
            payload: { ref: "body-2" },
            deduplicationId: "note-2",
          },
          consumers: [],
          body: { id: "body-2", json: { text: "fresh" } },
        }),
      Error,
      "already exists with different content",
    );
    assertEquals(
      await store.getEventByDeduplicationId("tenant-a", "note-2"),
      null,
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
    assertEquals(await store.succeedDelivery(id, "wrong-owner"), null);
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

Deno.test("non-retryable delivery failures dead-letter on the first attempt", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const committed = await store.append({
      type: "work.invalid",
      namespace: "tenant-a",
      payload: {},
      correlationId: "non-retryable-scope",
    }, ["worker"]);
    const id = committed.deliveries[0].id;
    const claimed = await store.claimDelivery({
      id,
      owner: "owner-permanent",
      leaseMs: 60_000,
    });
    assertEquals(claimed?.attempts, 1);

    const failed = await store.failDelivery({
      id,
      owner: "owner-permanent",
      error: new TypeError("invalid durable input"),
      retryable: false,
    });

    assertEquals(failed?.status, "dead_letter");
    assertEquals(failed?.attempts, 1);
    assertEquals(failed?.lastError?.retryable, false);
    assertExists(failed?.settledAt);
    assertEquals(
      await store.scopeSettlement("tenant-a", committed.event.id),
      { unsettled: 0, deadLetters: 1, cancelled: 0, succeeded: 0 },
    );
  } finally {
    await closeFixture(fixture);
  }
});

const recoveryPostgresUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
for (
  const backend of [
    { name: "PGlite", url: ":memory:", ignore: false },
    {
      name: "PostgreSQL",
      url: recoveryPostgresUrl ?? "",
      ignore: !recoveryPostgresUrl,
    },
  ]
) {
  Deno.test({
    name:
      `recovery delay distinguishes empty, due, deferred and settled queues (${backend.name})`,
    ignore: backend.ignore,
    async fn() {
      const schema = `recovery_delay_${
        crypto.randomUUID().replaceAll("-", "")
      }`;
      const fixture = await createFixture(backend.url, schema);
      const { store } = fixture;
      try {
        assertEquals(await store.nextRecoveryDelayMs(), null);
        const committed = await store.append({
          type: "work.created",
          namespace: "tenant-a",
          payload: {},
        }, ["worker"]);
        const id = committed.deliveries[0].id;
        assertEquals(await store.nextRecoveryDelayMs(), 0);

        assertExists(
          await store.claimDelivery({ id, owner: "worker", leaseMs: 60_000 }),
        );
        const leaseDelay = await store.nextRecoveryDelayMs();
        assert(leaseDelay !== null && leaseDelay > 0 && leaseDelay <= 60_000);

        await store.failDelivery({
          id,
          owner: "worker",
          error: new Error("retry later"),
          backoffMs: 60_000,
        });
        const retryDelay = await store.nextRecoveryDelayMs();
        assert(retryDelay !== null && retryDelay > 0 && retryDelay <= 60_000);
        const tables = createCoreTableNames(schema);
        await fixture.session.query(
          `UPDATE ${tables.event_deliveries}
           SET available_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
          [id],
        );
        assertEquals(await store.nextRecoveryDelayMs(), 0);
        assertExists(
          await store.claimDelivery({ id, owner: "retry", leaseMs: 60_000 }),
        );
        assertEquals(
          (await store.succeedDelivery(id, "retry"))?.status,
          "succeeded",
        );
        assertEquals(await store.nextRecoveryDelayMs(), null);

        // Exhausted leases still terminalize in the same recovery query.
        const exhausted = await store.append(
          {
            type: "work.exhausted",
            namespace: "tenant-a",
            payload: {},
          },
          ["worker"],
          { maxAttempts: 1 },
        );
        const exhaustedId = exhausted.deliveries[0].id;
        assertExists(
          await store.claimDelivery({
            id: exhaustedId,
            owner: "crashed",
            leaseMs: 0,
          }),
        );
        assertEquals(await store.nextRecoveryDelayMs(), null);
        assertEquals(
          (await store.getDelivery(exhaustedId))?.status,
          "dead_letter",
        );
      } finally {
        if (backend.name === "PostgreSQL") {
          await fixture.session.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
        await closeFixture(fixture);
      }
    },
  });
}

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
    assertEquals((await store.succeedDelivery(id, owner))?.status, "succeeded");

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

Deno.test("A23 settlement and cancellation follow explicit scope, not shared correlation", async () => {
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
      settlementScopeId: root.event.id,
    }, ["llm"]);
    const grandchild = await store.append({
      type: "tool_execution.created",
      namespace: "tenant-a",
      payload: {},
      causationId: child.event.id,
      correlationId: "shared-correlation",
      settlementScopeId: root.event.id,
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

Deno.test("internal scope counts preserve every status, expired leases and namespace isolation", async () => {
  const fixture = await createFixture();
  const { store, session } = fixture;
  try {
    const scope = "shared-explicit-scope";
    const consumers = [
      "pending",
      "leased",
      "retry_wait",
      "dead_letter",
      "cancelled",
      "succeeded",
      "expired",
      "exhausted",
    ];
    for (const namespace of ["tenant-a", "tenant-b"]) {
      await store.append({
        type: "scope.fixture",
        namespace,
        settlementScopeId: scope,
        payload: {},
      }, consumers);
    }
    // Set all states together so no earlier claim/recovery call terminalizes
    // the exhausted lease before the completion query's snapshot sees it.
    await session.query(
      `UPDATE ${store.tables.event_deliveries}
       SET status = CASE WHEN consumer_id IN ('expired', 'exhausted')
                     THEN 'leased' ELSE consumer_id END,
           attempts = CASE WHEN consumer_id = 'exhausted' THEN 3 ELSE 1 END,
           lease_owner = CASE WHEN consumer_id IN ('leased', 'expired', 'exhausted')
                          THEN 'gone-worker' END,
           lease_expires_at = CASE WHEN consumer_id = 'leased'
                               THEN NOW() + INTERVAL '1 hour'
                               WHEN consumer_id IN ('expired', 'exhausted')
                               THEN NOW() - INTERVAL '1 hour' END
       WHERE settlement_scope_id = $1`,
      [scope],
    );
    assertEquals(await store.scopeOutstanding("tenant-a", scope), {
      unsettled: 4,
      deadLetters: 2,
      cancelled: 1,
    });
    // The existing query also recovers exhausted leases outside this namespace.
    const deliveries = await store.listDeliveries({ namespace: "tenant-b" });
    const exhausted = deliveries.find((delivery) =>
      delivery.consumerId === "exhausted"
    );
    assertEquals(exhausted?.status, "dead_letter");
    assertEquals(exhausted?.leaseOwner, undefined);
    assertEquals(exhausted?.leaseExpiresAt, undefined);
    assertExists(exhausted?.settledAt);
    assertEquals(exhausted?.lastError?.name, "DeliveryLeaseExpired");
    assertEquals(
      deliveries.find((delivery) => delivery.consumerId === "expired")?.status,
      "leased",
    );
    assertEquals(await store.scopeOutstanding("tenant-b", scope), {
      unsettled: 4,
      deadLetters: 2,
      cancelled: 1,
    });
    assertEquals(await store.scopeSettlement("tenant-a", scope), {
      unsettled: 4,
      deadLetters: 2,
      cancelled: 1,
      succeeded: 1,
    });
    assertEquals(await store.scopeOutstanding("tenant-missing", scope), {
      unsettled: 0,
      deadLetters: 0,
      cancelled: 0,
    });
    assertEquals(await store.scopeOutstanding("tenant-a", "missing-scope"), {
      unsettled: 0,
      deadLetters: 0,
      cancelled: 0,
    });
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("internal scope check reads only non-success rows as successful history grows", async () => {
  const postgresUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
  const schema = postgresUrl
    ? `copilotz_scope_scale_${crypto.randomUUID().replaceAll("-", "")}`
    : TEST_SCHEMA;
  const fixture = await createFixture(postgresUrl || ":memory:", schema);
  const captured: { sql: string; params: unknown[] }[] = [];
  const instrumented: SqlSession = {
    ...fixture.session,
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      captured.push({ sql, params: [...(params ?? [])] });
      return await fixture.session.query<TRow>(sql, params);
    },
  };
  const store = createEventStore({
    session: instrumented,
    schema,
  });
  try {
    const scope = "history-scope";
    await store.append({
      type: "history.fixture",
      namespace: "tenant-a",
      settlementScopeId: scope,
      payload: {},
    }, ["active"]);
    await store.append({
      type: "history.fixture",
      namespace: "tenant-b",
      settlementScopeId: scope,
      payload: {},
    }, ["other-active"]);
    let previousCount = 0;
    for (const count of [1_000, 10_000]) {
      await fixture.session.query(
        `INSERT INTO ${store.tables.events} (id, schema_version, type, namespace, payload, correlation_id)
         SELECT 'history-event-' || n, 5, 'history.fixture', 'tenant-a', '{}', 'history-correlation'
         FROM generate_series($1::integer, $2::integer) AS fixture(n)`,
        [previousCount + 1, count],
      );
      await fixture.session.query(
        `INSERT INTO ${store.tables.event_deliveries} (id, event_id, consumer_id, settlement_scope_id, status)
         SELECT 'history-delivery-' || n, 'history-event-' || n, 'worker', $3, 'succeeded'
         FROM generate_series($1::integer, $2::integer) AS fixture(n)`,
        [previousCount + 1, count, scope],
      );
      await fixture.session.query(`ANALYZE ${store.tables.events}`);
      await fixture.session.query(`ANALYZE ${store.tables.event_deliveries}`);
      captured.length = 0;
      assertEquals(await store.scopeOutstanding("tenant-a", scope), {
        unsettled: 1,
        deadLetters: 0,
        cancelled: 0,
      });
      assertEquals(
        captured.length,
        1,
        "one completion check is one SQL statement",
      );
      const query = captured[0];
      type Plan = Record<string, unknown> & { Plans?: Plan[] };
      const explained = await fixture.session.query<
        { "QUERY PLAN": { Plan: Plan }[] }
      >(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        query.params,
      );
      const root = explained.rows[0]["QUERY PLAN"][0].Plan;
      const scans: Plan[] = [];
      const visit = (plan: Plan) => {
        if (
          plan["Relation Name"] === "event_deliveries" &&
          String(plan["Node Type"]).includes("Scan")
        ) scans.push(plan);
        plan.Plans?.forEach(visit);
      };
      visit(root);
      assert(scans.length > 0, "EXPLAIN should report delivery access");
      for (const scan of scans) {
        assert(
          scan["Node Type"] !== "Seq Scan",
          "successful history must not be sequentially scanned",
        );
        assert(
          Number(scan["Actual Rows"]) <= 2,
          "only the two namespaces' non-success rows reach delivery scans",
        );
        assert(
          Number(scan["Rows Removed by Filter"] ?? 0) <= 2,
          "successful rows must be skipped by the index",
        );
      }
      const scopedScan = scans.find((scan) =>
        scan["Index Name"] === "deliveries_settlement_scope_idx"
      );
      assertExists(
        scopedScan,
        "the existing (scope, status) index should bound settlement work",
      );
      assertEquals(scopedScan["Actual Rows"], 2);
      console.log(JSON.stringify({
        successfulHistory: count,
        statements: captured.length,
        deliveryRows: scans.map((scan) => scan["Actual Rows"]),
        sharedHitBlocks: root["Shared Hit Blocks"],
        sharedReadBlocks: root["Shared Read Blocks"],
      }));
      assertEquals(await store.scopeSettlement("tenant-a", scope), {
        unsettled: 1,
        deadLetters: 0,
        cancelled: 0,
        succeeded: count,
      });
      previousCount = count;
    }
  } finally {
    try {
      if (postgresUrl) {
        await fixture.session.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await closeFixture(fixture);
    }
  }
});

Deno.test("one event atomically forks inherited and detached delivery scopes", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const committed = await store.commitMutation({
      draft: {
        type: "message.created",
        namespace: "tenant-a",
        payload: {},
      },
      consumers: [
        { consumerId: "foreground", settlement: "inherit" },
        { consumerId: "memory", settlement: "detached" },
      ],
      mutate: () => Promise.resolve(undefined),
    });
    const foreground = committed.deliveries.find((delivery) =>
      delivery.consumerId === "foreground"
    );
    const memory = committed.deliveries.find((delivery) =>
      delivery.consumerId === "memory"
    );
    assertExists(foreground);
    assertExists(memory);
    assertEquals(foreground.settlementScopeId, committed.event.id);
    assert(memory.settlementScopeId !== committed.event.id);
    assertEquals(
      await store.scopeSettlement("tenant-a", committed.event.id),
      { unsettled: 1, deadLetters: 0, cancelled: 0, succeeded: 0 },
    );
    assertEquals(
      await store.scopeSettlement("tenant-a", memory.settlementScopeId),
      { unsettled: 1, deadLetters: 0, cancelled: 0, succeeded: 0 },
    );

    const child = await store.append({
      type: "long_term_memory.created",
      namespace: "tenant-a",
      payload: {},
      causationId: committed.event.id,
      correlationId: committed.event.correlationId,
      settlementScopeId: memory.settlementScopeId,
    }, ["memory.prepare"]);
    assertEquals(
      child.deliveries[0].settlementScopeId,
      memory.settlementScopeId,
    );
    assertEquals(
      await store.cancelScope("tenant-a", committed.event.id),
      1,
    );
    assertEquals((await store.getDelivery(memory.id))?.status, "pending");
    assertEquals(
      (await store.getDelivery(child.deliveries[0].id))?.status,
      "pending",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A22 delivery compaction removes only old fully settled obligations", async () => {
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
      await store.compactDeliveries({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
      }),
      { deliveries: 1 },
    );
    assertEquals(await store.getEvent(settled.event.id), settled.event);
    assertEquals(await store.getEvent(passive.event.id), passive.event);
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

Deno.test("A22 delivery compaction never removes immutable Events", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const old = "2020-01-01T00:00:00.000Z";
    const parent = await store.append({
      type: "old.parent",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    });
    const child = await store.append({
      type: "old.child",
      namespace: "tenant-a",
      payload: {},
      causationId: parent.event.id,
      createdAt: old,
    });
    const unrelated = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        store.append({
          type: `old.unrelated.${index}`,
          namespace: "tenant-a",
          payload: {},
          createdAt: old,
        })),
    );

    const first = await store.compactDeliveries({
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      now: new Date("2021-01-01T00:00:00.000Z"),
      limit: 1,
    });
    assertEquals(first, { deliveries: 0 });
    assertEquals(await store.getEvent(parent.event.id) !== null, true);

    for (let index = 0; index < 4; index++) {
      const result = await store.compactDeliveries({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
        limit: 1,
      });
      assertEquals(result, { deliveries: 0 });
    }
    assertEquals(await store.getEvent(parent.event.id), parent.event);
    assertEquals(await store.getEvent(child.event.id), child.event);
    for (const event of unrelated) {
      assertEquals(await store.getEvent(event.event.id), event.event);
    }
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A22 delivery compaction is bounded and retains immutable Events", async () => {
  const fixture = await createFixture();
  const { store } = fixture;
  try {
    const old = "2020-01-01T00:00:00.000Z";
    const committed = await store.append({
      type: "old.settled.batch",
      namespace: "tenant-a",
      payload: {},
      createdAt: old,
    }, ["consumer-a", "consumer-b"]);
    for (const [index, delivery] of committed.deliveries.entries()) {
      const owner = `settled-${index}`;
      await store.claimDelivery({ id: delivery.id, owner });
      await store.succeedDelivery(delivery.id, owner);
    }

    assertEquals(
      await store.compactDeliveries({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
        limit: 1,
      }),
      { deliveries: 1 },
    );
    assertEquals(await store.getEvent(committed.event.id) !== null, true);

    assertEquals(
      await store.compactDeliveries({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
        limit: 1,
      }),
      { deliveries: 1 },
    );
    assertEquals(await store.getEvent(committed.event.id), committed.event);
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
