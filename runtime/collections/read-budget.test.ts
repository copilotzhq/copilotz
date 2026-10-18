import { OWNER_ORDINARY_SOURCE_SQL } from "../owner/ordinary-source-sql.ts";
import { assertOwnerOrdinaryValue } from "../owner/ordinary-value.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineCollection } from "./definition.ts";
import { queryCollectionRecords } from "./query.ts";
import { aggregateCollectionRecords } from "./aggregate.ts";
import {
  type CollectionReadBudget,
  queryCollectionRows,
} from "./read-budget.ts";
import type { CollectionAggregateQuery, CollectionQuery } from "./types.ts";

const budget = { maxRowBytes: 512, maxResultBytes: 2048 };
const definition = defineCollection({
  name: "entry",
  schema: {
    type: "object",
    properties: { label: { type: "string" }, rank: { type: "number" } },
  },
});

async function fixture() {
  const db = await createTestDatabase();
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
    list(query: CollectionQuery = {}, limits = budget) {
      return queryCollectionRecords(
        executor,
        tables,
        definition,
        "tenant",
        query,
        limits,
      );
    },
    aggregate(
      query: CollectionAggregateQuery,
      limits = budget,
      sourceCheck?: string,
    ) {
      return aggregateCollectionRecords(
        executor,
        tables,
        definition,
        "tenant",
        query,
        limits,
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

Deno.test("bounded Collection oversized row is refused before driver JSON materialization", async () => {
  const f = await fixture();
  try {
    await f.put("large", { label: "secret-payload".repeat(10000) });
    await assertRejects(() => f.list(), RangeError, "transfer budget");
    assertEquals(f.responses, [[{ bounded_value: null, oversized: true }]]);
  } finally {
    await f.close();
  }
});

Deno.test("bounded Collection total budget refuses whole page rather than truncating", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c"]) {
      await f.put(id, { label: "x".repeat(250) });
    }
    await assertRejects(
      () => f.list({}, { maxRowBytes: 512, maxResultBytes: 600 }),
      RangeError,
      "transfer budget",
    );
    assertEquals(f.responses, [Array.from({ length: 3 }, () => ({
      bounded_value: null,
      oversized: true,
    }))]);
  } finally {
    await f.close();
  }
});

Deno.test("bounded Collection cursor value is bounded before transfer", async () => {
  const f = await fixture();
  try {
    await f.put("cursor", { label: "large-cursor".repeat(10000) });
    await assertRejects(
      () => f.list({ order: { field: "label" }, after: "cursor" }),
      RangeError,
      "transfer budget",
    );
    assertEquals(f.responses, [[{ bounded_value: null, oversized: true }]]);
  } finally {
    await f.close();
  }
});

Deno.test("bounded aggregate refuses huge group values before transfer", async () => {
  const f = await fixture();
  try {
    await f.put("large", { label: "large-group".repeat(10000) });
    await assertRejects(
      () =>
        f.aggregate({ groupBy: ["label"], metrics: { n: { op: "count" } } }),
      RangeError,
      "transfer budget",
    );
    assertEquals(f.responses, [[{ bounded_value: null, oversized: true }]]);
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

Deno.test("bounded Collection budgets count UTF-8 bytes and reject relation hydration", async () => {
  const f = await fixture();
  try {
    await f.put("utf8", { label: "😀".repeat(150) });
    await assertRejects(() => f.list(), RangeError, "transfer budget");
    assertEquals(f.responses, [[{ bounded_value: null, oversized: true }]]);
    await assertRejects(
      () => f.list({ include: ["other"] }),
      TypeError,
      "hydrate",
    );
    assertEquals(f.responses.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test("bounded Collection invalid budgets refuse before SQL", async () => {
  let calls = 0;
  const executor = {
    query: () => {
      calls++;
      return Promise.resolve({ rows: [] });
    },
  };
  for (
    const invalid of [
      null as unknown as CollectionReadBudget,
      false as unknown as CollectionReadBudget,
      { maxRowBytes: 0, maxResultBytes: 100 },
      { maxRowBytes: 1.5, maxResultBytes: 100 },
      { maxRowBytes: 100, maxResultBytes: 99 },
      { maxRowBytes: 100, maxResultBytes: Infinity },
    ]
  ) {
    await assertRejects(
      () => queryCollectionRows(executor, "SELECT 1", [], invalid),
      TypeError,
      "transfer budget",
    );
  }
  assertEquals(calls, 0);
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

Deno.test("owner read decoder refuses ambiguous legacy where column names", async () => {
  const { parseOwnerCollectionReadScope } = await import(
    "../execution/collection-read-call.ts"
  );
  const f = await fixture();
  try {
    await f.put("a", {
      namespace: "application-value",
      createdAt: "application-time",
    });
    // Preserve the existing compilers; the new owner boundary refuses ambiguity.
    assertEquals(
      (await f.list({ where: { namespace: "application-value" } })).length,
      1,
    );
    assertEquals(
      await f.aggregate({
        where: { namespace: "application-value" },
        metrics: { n: { op: "count" } },
      }),
      [{ n: 0 }],
    );
    for (const field of ["namespace", "createdAt", "updatedAt"]) {
      assertThrows(
        () =>
          parseOwnerCollectionReadScope({
            where: { [field]: "application-value" },
          }),
        TypeError,
      );
    }
    const filter = { field: "namespace", eq: "tenant" } as const;
    assertEquals((await f.list({ filter })).length, 1);
    assertEquals(
      await f.aggregate({ filter, metrics: { n: { op: "count" } } }),
      [{ n: 1 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner aggregate source protocol check traverses objects and mixed arrays", async () => {
  const db = await createTestDatabase();
  try {
    const unsafe = [
      { bodyId: "private" },
      { ref: { assetId: "private" } },
      [null, false, 1, { nested: [{ location: "private" }] }],
      {
        ref: {
          schema: "copilotz.action.protected-value.v999",
          value: "private",
        },
      },
      { schema: [null, ["copilotz.event.protected-value"]] },
      { schema: "copilotz.action.protected-value-aad.malformed" },
      { nested: { "$copilotz-secret": "private" } },
    ];
    for (const data of unsafe) {
      let refused = false;
      try {
        assertOwnerOrdinaryValue(data);
      } catch {
        refused = true;
      }
      assertEquals(refused, true);
      assertEquals(
        (await db.query(
          `SELECT ${OWNER_ORDINARY_SOURCE_SQL} AS safe FROM (SELECT $1::jsonb AS data) source`,
          [JSON.stringify(data)],
        )).rows[0].safe,
        false,
      );
    }
    // SQL also rejects protected families inside schema-valued objects.
    const conservative = {
      schema: { child: "copilotz.event.protected-value.v1" },
    };
    assertOwnerOrdinaryValue(conservative);
    assertEquals(
      (await db.query(
        `SELECT ${OWNER_ORDINARY_SOURCE_SQL} AS safe FROM (SELECT $1::jsonb AS data) source`,
        [JSON.stringify(conservative)],
      )).rows[0].safe,
      false,
    );
    for (
      const data of [null, 1, "text", [], {}, [null, true, { label: "fine" }], {
        schema: "copilotz.event.protected-values",
        bodyIdentifier: "fine",
      }]
    ) {
      assertOwnerOrdinaryValue(data);
      assertEquals(
        (await db.query(
          `SELECT ${OWNER_ORDINARY_SOURCE_SQL} AS safe FROM (SELECT $1::jsonb AS data) source`,
          [JSON.stringify(data)],
        )).rows[0].safe,
        true,
      );
    }
  } finally {
    await db.close();
  }
});

Deno.test("owner aggregate refuses protected source even through aliases and metric filters", async () => {
  const f = await fixture();
  try {
    assertEquals(
      await f.aggregate(
        { metrics: { n: { op: "count" } } },
        budget,
        OWNER_ORDINARY_SOURCE_SQL,
      ),
      [{ n: 0 }],
    );
    await f.put("a", {
      label: "same",
      ref: {
        schema: "copilotz.action.protected-value.v1",
        value: 42,
        bodyId: "private-body",
      },
    });
    await f.put("b", { label: "same", ref: { value: 1 } });
    // A projection-only guard misses the protected object's siblings/coordinates.
    const legacy = await f.aggregate({
      groupBy: ["ref.bodyId"],
      metrics: { n: { op: "count" } },
    });
    assertOwnerOrdinaryValue(legacy);
    assertEquals(legacy.some((r) => r["ref.bodyId"] === "private-body"), true);
    for (
      const query of [
        { groupBy: ["ref.bodyId"], metrics: { n: { op: "count" as const } } },
        {
          groupBy: ["label"],
          metrics: { innocent: { op: "sum" as const, field: "ref.value" } },
        },
        {
          metrics: {
            n: { op: "count" as const, filter: { field: "id", eq: "b" } },
          },
        },
      ] as CollectionAggregateQuery[]
    ) {
      const before = f.responses.length;
      await assertRejects(
        () => f.aggregate(query, budget, OWNER_ORDINARY_SOURCE_SQL),
        TypeError,
        "protected data",
      );
      const raw = f.responses[before] as {
        bounded_value: unknown;
        source_rejected: boolean;
      }[];
      assertEquals(
        raw.every((r) => r.bounded_value === null && r.source_rejected),
        true,
      );
    }
    await f.put("c", { label: "other" });
    await f.put("d", { label: "third" });
    await assertRejects(
      () =>
        f.aggregate(
          { groupBy: ["label"], metrics: { n: { op: "count" } }, limit: 1 },
          budget,
          OWNER_ORDINARY_SOURCE_SQL,
        ),
      TypeError,
      "protected data",
    );
    await assertRejects(
      () =>
        f.aggregate(
          { metrics: { __collection_source_rejected: { op: "count" } } },
          budget,
          OWNER_ORDINARY_SOURCE_SQL,
        ),
      TypeError,
      "Reserved",
    );
    await assertRejects(
      () =>
        f.aggregate(
          {
            groupBy: ["__collection_source_rejected"],
            metrics: { n: { op: "count" } },
          },
          budget,
          OWNER_ORDINARY_SOURCE_SQL,
        ),
      TypeError,
      "Reserved",
    );
    assertEquals(
      await f.aggregate(
        { where: { id: "b" }, metrics: { n: { op: "count" } } },
        budget,
        OWNER_ORDINARY_SOURCE_SQL,
      ),
      [{ n: 1 }],
    );
  } finally {
    await f.close();
  }
});
