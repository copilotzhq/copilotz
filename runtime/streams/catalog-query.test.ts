import { assertEquals, assertRejects } from "@std/assert";
import {
  createCoreTableNames,
  createEventStore,
  type EventStore,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  type OperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

type Fixture = Readonly<{
  database: TestDatabase;
  catalog: OperationCatalog;
  events: EventStore;
  operationTables: Awaited<ReturnType<typeof provisionOperationCatalog>>;
  schema: string;
}>;

async function createFixture(url: string): Promise<Fixture> {
  const schema = `catalog_query_${crypto.randomUUID().replaceAll("-", "")}`;
  const database = await createTestDatabase({ url });
  await provisionCopilotzSchema(database, schema);
  const operationTables = await provisionOperationCatalog(database, schema);
  const catalog = createOperationCatalog(database, schema);
  let nextEventId = 0;
  const events = createEventStore({
    session: database,
    schema,
    createId: () => `event-${++nextEventId}`,
    indexOperationEvent: (transaction, input) =>
      catalog.indexEvent(transaction, input),
  });
  return { database, catalog, events, operationTables, schema };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  try {
    await fixture.database.query(
      `DROP SCHEMA IF EXISTS "${fixture.schema}" CASCADE`,
    );
  } finally {
    await fixture.database.close();
  }
}

async function appendEvent(
  events: EventStore,
  input: Readonly<{
    namespace: string;
    metadata: Readonly<Record<string, unknown>>;
    settlementScopeId?: string;
    second: number;
  }>,
) {
  return await events.append({
    type: "catalog.query.fixture",
    namespace: input.namespace,
    payload: { fixture: true },
    metadata: input.metadata,
    ...(input.settlementScopeId
      ? { settlementScopeId: input.settlementScopeId }
      : {}),
    createdAt: new Date(1_767_264_000_000 + input.second * 1_000).toISOString(),
  });
}

async function updateOperationMetadata(
  fixture: Fixture,
  namespace: string,
  operationId: string,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await fixture.database.query(
    `UPDATE ${fixture.operationTables.operations}
        SET metadata = $3::jsonb
      WHERE namespace = $1 AND operation_id = $2`,
    [namespace, operationId, JSON.stringify(metadata)],
  );
}

async function runQueryFixture(url: string): Promise<void> {
  const fixture = await createFixture(url);
  try {
    const { catalog, events } = fixture;
    const operationOnly = await appendEvent(events, {
      namespace: "tenant-a",
      metadata: { source: "root" },
      second: 1,
    });
    await updateOperationMetadata(
      fixture,
      "tenant-a",
      operationOnly.event.id,
      { source: "root", association: { side: "operation" } },
    );

    const eventOnly = await appendEvent(events, {
      namespace: "tenant-a",
      metadata: { source: "root" },
      second: 3,
    });
    await appendEvent(events, {
      namespace: "tenant-a",
      metadata: { association: { side: "event" }, typed: 42 },
      settlementScopeId: eventOnly.event.id,
      second: 4,
    });

    const both = await appendEvent(events, {
      namespace: "tenant-a",
      metadata: { source: "root" },
      second: 5,
    });
    await updateOperationMetadata(
      fixture,
      "tenant-a",
      both.event.id,
      { source: "root", association: { side: "operation" } },
    );
    const bothProgress = await appendEvent(events, {
      namespace: "tenant-a",
      metadata: { association: { side: "event" }, typed: 42 },
      settlementScopeId: both.event.id,
      second: 6,
    });

    const otherNamespace = await appendEvent(events, {
      namespace: "tenant-b",
      metadata: { source: "root" },
      second: 7,
    });
    await appendEvent(events, {
      namespace: "tenant-b",
      metadata: { association: { side: "event" } },
      settlementScopeId: otherNamespace.event.id,
      second: 8,
    });

    const associated = await catalog.list({
      namespace: "tenant-a",
      association: {
        operationMetadata: { association: { side: "operation" } },
        eventMetadata: { association: { side: "event" } },
      },
    });
    assertEquals(
      associated.map((operation) => operation.operationId),
      [both.event.id, eventOnly.event.id, operationOnly.event.id],
    );

    const operationMetadataAndAssociation = await catalog.list({
      namespace: "tenant-a",
      metadata: { source: "root" },
      association: { eventMetadata: { association: { side: "event" } } },
      limit: 2,
    });
    assertEquals(
      operationMetadataAndAssociation.map((operation) => operation.operationId),
      [both.event.id, eventOnly.event.id],
    );

    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        association: { eventMetadata: { association: { side: "event" } } },
        metadata: { source: "does-not-match" },
      })).length,
      0,
    );
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        association: { eventMetadata: { typed: "42" } },
      })).length,
      0,
    );
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        association: { eventMetadata: { typed: 42 } },
      })).map((operation) => operation.operationId),
      [both.event.id, eventOnly.event.id],
    );

    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        operationIds: [eventOnly.event.id],
        association: { eventMetadata: { association: { side: "event" } } },
        limit: 1,
      })).map((operation) => operation.operationId),
      [eventOnly.event.id],
    );
    assertEquals(
      await catalog.list({
        namespace: "tenant-a",
        operationIds: [],
        association: { eventMetadata: { association: { side: "event" } } },
      }),
      [],
    );
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        association: { eventMetadata: { association: { side: "event" } } },
        states: ["running"],
      })).map((operation) => operation.operationId),
      [both.event.id, eventOnly.event.id],
    );

    assertEquals(
      await catalog.mark("tenant-a", both.event.id, "completed"),
      true,
    );
    const beforeBothProgress = (BigInt(bothProgress.event.position) - 1n)
      .toString();
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        states: ["completed"],
        association: { eventMetadata: { association: { side: "event" } } },
      })).map((operation) => operation.operationId),
      [both.event.id],
    );
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        states: ["completed"],
        association: { eventMetadata: { association: { side: "event" } } },
        afterPosition: beforeBothProgress,
      })).map((operation) => operation.operationId),
      [both.event.id],
    );
    assertEquals(
      await catalog.list({
        namespace: "tenant-a",
        states: ["completed"],
        association: { eventMetadata: { association: { side: "event" } } },
        afterPosition: bothProgress.event.position,
      }),
      [],
    );
    assertEquals(
      (await catalog.list({
        namespace: "tenant-a",
        association: { eventMetadata: { association: { side: "event" } } },
        afterPosition: "999",
      })).map((operation) => operation.operationId),
      [eventOnly.event.id],
    );

    const eventWatermark = await catalog.maxEventPosition({
      namespace: "tenant-a",
      eventMetadata: { association: { side: "event" } },
    });
    assertEquals(eventWatermark, bothProgress.event.position);
    assertEquals(
      await catalog.maxEventPosition({
        namespace: "tenant-a",
        eventMetadata: { typed: "42" },
      }),
      undefined,
    );
    assertEquals(
      await catalog.maxEventPosition({
        namespace: "tenant-a",
        eventMetadata: { typed: 42 },
      }),
      bothProgress.event.position,
    );
    assertEquals(
      await catalog.maxEventPosition({
        namespace: "tenant-a",
        eventMetadata: {},
      }),
      bothProgress.event.position,
    );
    assertEquals(
      await catalog.maxEventPosition({
        namespace: "missing",
        eventMetadata: {},
      }),
      undefined,
    );
  } finally {
    await closeFixture(fixture);
  }
}

Deno.test("operation catalog association queries stay generic and bounded", async () => {
  await runQueryFixture(":memory:");
});

Deno.test({
  name: "operation catalog association queries work on native PostgreSQL",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => runQueryFixture(POSTGRES_URL!),
});

Deno.test("operation catalog query inputs reject ambiguous values", async () => {
  const fixture = await createFixture(":memory:");
  try {
    const { catalog } = fixture;
    await assertRejects(
      () => catalog.list({ namespace: "", association: { eventMetadata: {} } }),
      TypeError,
    );
    await assertRejects(
      () => catalog.list({ namespace: "tenant-a", limit: 0 }),
      TypeError,
    );
    await assertRejects(
      () => catalog.list({ namespace: "tenant-a", afterPosition: "1.0" }),
      TypeError,
    );
    await assertRejects(
      () => catalog.list({ namespace: "tenant-a", association: {} }),
      TypeError,
    );
    for (const branch of [null, "event", [], undefined]) {
      await assertRejects(
        () =>
          catalog.list({
            namespace: "tenant-a",
            association: { eventMetadata: branch as never },
          }),
        TypeError,
      );
    }
    await assertRejects(
      () =>
        catalog.list({
          namespace: "tenant-a",
          association: { operationMetadata: null as never },
        }),
      TypeError,
    );
    await assertRejects(
      () => catalog.list({ namespace: "tenant-a", operationIds: [""] }),
      TypeError,
    );
    await assertRejects(
      () =>
        catalog.maxEventPosition({
          namespace: "tenant-a",
          eventMetadata: "event" as never,
        }),
      TypeError,
    );
  } finally {
    await closeFixture(fixture);
  }
});
