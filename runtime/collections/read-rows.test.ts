import { assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { defineCollection } from "./definition.ts";
import { queryCollectionRecords } from "./query.ts";
import { aggregateCollectionRecords } from "./aggregate.ts";
import { queryCollectionRows } from "./read-rows.ts";
import type { CollectionAggregateQuery, CollectionQuery } from "./types.ts";

const definition = defineCollection({
  name: "entry",
  schema: {
    type: "object",
    properties: { label: { type: "string" }, rank: { type: "number" } },
  },
});

async function fixture() {
  const db = await createOwnerTestDatabase();
  const tables = { nodes: "bounded_nodes", edges: "unused_edges" };
  const responses: unknown[] = [];
  const executor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      const result = await db.query<T>(sql, params);
      responses.push(result.rows);
      return result;
    },
  };
  try {
    await db.query(`CREATE TABLE bounded_nodes (
      id text, namespace text, type text, data jsonb, content text,
      created_at timestamptz, updated_at timestamptz)`);
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    close: db.close,
    responses,
    async put(
      id: string,
      data: unknown,
      namespace = "tenant",
      timestamp = "2026-01-01T00:00:00.123456Z",
    ) {
      await db.query(
        `INSERT INTO bounded_nodes VALUES ($1, $2, 'entry', $3::jsonb,
          repeat('unused content', 10000),
          $4::timestamptz, $4::timestamptz)`,
        [id, namespace, JSON.stringify(data), timestamp],
      );
    },
    list(query: CollectionQuery = {}) {
      return queryCollectionRecords(
        executor,
        tables,
        definition,
        "tenant",
        query,
      );
    },
    aggregate(
      query: CollectionAggregateQuery,
      sourceCheck?: string,
    ) {
      return aggregateCollectionRecords(
        executor,
        tables,
        definition,
        "tenant",
        query,
        sourceCheck,
      );
    },
  };
}

Deno.test("bounded Collection reads preserve order, scoped cursor and data without unused content", async () => {
  const f = await fixture();
  try {
    await f.put("a", { label: "first", rank: 2 });
    await f.put("b", { label: "second", rank: 1 });
    await f.put("c", { label: "third", rank: 3 });
    await f.put("foreign", { label: "hidden", rank: 4 }, "other");
    const order = { field: "rank", direction: "desc" } as const;
    assertEquals((await f.list({ order })).map((r) => r.id), ["c", "a", "b"]);
    assertEquals<unknown>(await f.list({ order, after: "c", limit: 1 }), [
      { id: "a", namespace: "tenant", label: "first", rank: 2 },
    ]);
    await assertRejects(
      () => f.list({ after: "foreign" }),
      RangeError,
      "scope",
    );
    assertEquals(JSON.stringify(f.responses).includes("unused content"), false);
    assertEquals(
      JSON.stringify(f.responses).includes("__collection_read_order"),
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test("bounded aggregate preserves metrics and group capacity refusal", async () => {
  const f = await fixture();
  try {
    await f.put("a", { label: "one", rank: 3 });
    await f.put("b", { label: "two", rank: 5 });
    assertEquals(
      await f.aggregate({
        metrics: { n: { op: "count" }, total: { op: "sum", field: "rank" } },
      }),
      [{ n: 2, total: 8 }],
    );
    await assertRejects(
      () =>
        f.aggregate({
          groupBy: ["label"],
          metrics: { n: { op: "count" } },
          limit: 1,
        }),
      RangeError,
      "group capacity",
    );
  } finally {
    await f.close();
  }
});

Deno.test("bounded Collection keysets retain microseconds and null/tie ordering", async () => {
  const f = await fixture();
  try {
    await f.put("a", { rank: 1 }, "tenant", "2026-01-01T00:00:00.123001Z");
    await f.put("b", { rank: 1 }, "tenant", "2026-01-01T00:00:00.123002Z");
    await f.put("c", { rank: null }, "tenant", "2026-01-01T00:00:00.123002Z");
    await f.put("d", { rank: 2 }, "tenant", "2026-01-01T00:00:00.123003Z");
    for (const field of ["createdAt", "rank"]) {
      for (const direction of ["asc", "desc"] as const) {
        const ordered = field === "createdAt"
          ? ["a", "b", "c", "d"]
          : ["a", "b", "d", "c"];
        if (direction === "desc") ordered.reverse();
        const order = { field, direction };
        assertEquals((await f.list({ order })).map((r) => r.id), ordered);
        for (let i = 0; i < ordered.length; i++) {
          assertEquals(
            (await f.list({ order, after: ordered[i] })).map((r) => r.id),
            ordered.slice(i + 1),
          );
          assertEquals(
            (await f.list({ order, before: ordered[i] })).map((r) => r.id),
            ordered.slice(0, i),
          );
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test("bounded aggregate scalar equality matches ordinary list scopes", async () => {
  const f = await fixture();
  try {
    await f.put("a", { rank: 1, enabled: true });
    await f.put("b", { rank: 2, enabled: false });
    for (const where of [{ rank: 1 }, { enabled: true }]) {
      const listed = await f.list({ where });
      assertEquals(
        await f.aggregate({
          all: [{ where }],
          metrics: { n: { op: "count" } },
        }),
        [{ n: listed.length }],
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("guarded aggregate refuses rejected source before aliases, metric filters or capacity can hide it", async () => {
  const f = await fixture();
  try {
    await f.put("visible", { label: "allowed", rank: 1 });
    await f.put("hidden", { label: "restricted", rank: 2 });
    for (
      const query of [
        { metrics: { total: { op: "count" as const } } },
        {
          metrics: {
            total: {
              op: "count" as const,
              filter: { field: "label", eq: "allowed" },
            },
          },
        },
        {
          groupBy: ["label"],
          limit: 1,
          metrics: { n: { op: "count" as const } },
        },
      ] as CollectionAggregateQuery[]
    ) {
      await assertRejects(
        () => f.aggregate(query, "id <> 'hidden'"),
        TypeError,
        "source",
      );
    }
    assertEquals(JSON.stringify(f.responses).includes("restricted"), false);
  } finally {
    await f.close();
  }
});

Deno.test("Collection reads refuse row overflow", async () => {
  await assertRejects(
    () =>
      queryCollectionRows(
        { query: () => Promise.resolve({ rows: Array(10001).fill({}) }) },
        "SELECT 1",
        [],
      ),
    RangeError,
    "row capacity",
  );
});
