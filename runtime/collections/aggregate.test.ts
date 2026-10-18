import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createCollectionRuntime, defineCollection } from "./index.ts";

async function fixture() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "collection_aggregate";
  await provisionCopilotzSchema(session, schema);
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "aggregate-test",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let observed: readonly Record<string, string | number | boolean | null>[] =
    [];
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
  });
  const usage = runtime.bind(defineCollection({
    name: "usage",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        kind: { type: "string" },
        status: { type: "string" },
        amount: {},
        occurredAt: {},
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["id", "namespace", "kind", "createdAt", "updatedAt"],
    },
    queries: {
      grouped: {
        async select({ read }) {
          observed = await read.aggregate("usage", {
            groupBy: ["kind"],
            metrics: { rows: { op: "count" } },
          });
          return [];
        },
      },
    },
  }));
  return {
    db,
    executor,
    scoped: runtime.withScope({ namespace: "tenant-a" }).usage,
    other: runtime.withScope({ namespace: "tenant-b" }).usage,
    observed: () => observed,
  };
}

Deno.test("collection aggregation is SQL-scoped, numeric-safe, and bounded", async () => {
  const value = await fixture();
  try {
    for (
      const row of [
        {
          id: "a",
          kind: "chat",
          status: "ok",
          amount: 2,
          occurredAt: "2026-01-01T00:15:00.000Z",
          tags: ["trusted", "chat"],
          scalar: true,
        },
        {
          id: "b",
          kind: "chat",
          status: "failed",
          amount: 4,
          occurredAt: "2026-01-01T00:45:00.000Z",
          tags: ["chat"],
          scalar: 7,
        },
        {
          id: "c",
          kind: "embed",
          status: "ok",
          amount: "bad",
          occurredAt: "2026-01-01T01:05:00.000Z",
          tags: ["trusted"],
          scalar: "text",
        },
        {
          id: "d",
          kind: "embed",
          status: "ok",
          occurredAt: "2025-12-31T23:00:00.000Z",
          tags: ["other"],
        },
      ]
    ) await value.scoped.create(row);
    await value.other.create({
      id: "other",
      namespace: "tenant-b",
      kind: "chat",
      amount: 99,
    });

    assertEquals(
      await value.scoped.aggregate({
        groupBy: ["kind"],
        metrics: {
          rows: { op: "count" },
          numeric: { op: "count", field: "amount" },
          totalAmount: { op: "sum", field: "amount" },
          average: { op: "avg", field: "amount" },
          successful: { op: "count", filter: { field: "status", eq: "ok" } },
        },
      }),
      [
        {
          kind: "chat",
          rows: 2,
          numeric: 2,
          totalAmount: 6,
          average: 3,
          successful: 1,
        },
        {
          kind: "embed",
          rows: 2,
          numeric: 0,
          totalAmount: null,
          average: null,
          successful: 2,
        },
      ],
    );
    assertEquals(
      await value.scoped.aggregate({
        filter: { field: "occurredAt", gte: "2026-01-01T00:30:00.000Z" },
        groupBy: [{ field: "occurredAt", interval: "hour" }],
        metrics: { rows: { op: "count" } },
      }),
      [{ bucket: "2026-01-01T00:00:00.000Z", rows: 1 }, {
        bucket: "2026-01-01T01:00:00.000Z",
        rows: 1,
      }],
    );
    assertEquals(
      await value.scoped.aggregate({
        filter: { field: "occurredAt", gt: "2030-01-01T00:00:00.000Z" },
        metrics: { rows: { op: "count" } },
      }),
      [{ rows: 0 }],
    );
    assertEquals(
      await value.scoped.aggregate({
        all: [
          { contains: { tags: ["trusted"] } },
          { containsAny: { tags: ["chat", "absent"] } },
        ],
        metrics: { rows: { op: "count" } },
      }),
      [{ rows: 1 }],
    );
    assertEquals(
      await value.scoped.aggregate({
        // A caller selection still intersects the authorization-style `all`
        // restrictions before aggregation.
        filter: { field: "kind", eqIgnoreCase: "CHAT" },
        all: [
          { filter: { field: "status", eqIgnoreCase: "ok" } },
          { contains: { tags: ["trusted"] } },
        ],
        metrics: { rows: { op: "count" } },
      }),
      [{ rows: 1 }],
    );
    const scalarGroups = await value.scoped.aggregate({
      groupBy: ["scalar"],
      metrics: { rows: { op: "count" } },
    });
    assertEquals(
      new Set(scalarGroups.map((row) => row.scalar)),
      new Set([true, 7, "text", null]),
    );
    const createdBuckets = await value.scoped.aggregate({
      groupBy: [{ field: "createdAt", interval: "hour" }],
      metrics: { rows: { op: "count" } },
    });
    assertEquals(createdBuckets.length, 1);
    assertEquals(typeof createdBuckets[0].bucket, "string");
    assertEquals((createdBuckets[0].bucket as string).endsWith("Z"), true);
    assertEquals(createdBuckets[0].rows, 4);
    await value.scoped.queries.grouped();
    assertEquals(value.observed(), [{ kind: "chat", rows: 2 }, {
      kind: "embed",
      rows: 2,
    }]);
    await assertRejects(
      () => value.scoped.aggregate({ metrics: { "x; DROP": { op: "count" } } }),
      TypeError,
    );
    await assertRejects(
      () =>
        value.scoped.aggregate({
          all: [{ unsupported: true } as never],
          metrics: { rows: { op: "count" } },
        }),
      TypeError,
    );
    await assertRejects(
      () =>
        value.scoped.aggregate({
          groupBy: ["kind"],
          metrics: { rows: { op: "count" } },
          limit: 1,
        }),
      RangeError,
    );
    await assertRejects(
      () =>
        value.scoped.aggregate({
          metrics: { rows: { op: "count" } },
          limit: 10_001,
        }),
      RangeError,
    );
  } finally {
    await value.executor.shutdown();
    await value.db.close();
  }
});
