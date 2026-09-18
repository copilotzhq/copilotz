import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createSqlSession } from "../events/index.ts";
import { defineCollection } from "./definition.ts";
import { queryCollectionRecords } from "./query.ts";
import {
  type CollectionPredicate,
  compileCollectionPredicate,
  matchesCollectionFilter,
} from "./predicate.ts";
import type { CollectionQuery } from "./types.ts";

Deno.test("collection predicate compiler filters and paginates in PGlite with exact scope and value semantics", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const tables = { nodes: "predicate_nodes", edges: "unused_edges" };
  const definition = defineCollection({
    name: "entry",
    schema: { type: "object" },
  });
  try {
    await session.query(
      `CREATE TABLE predicate_nodes (id text, namespace text, type text, data jsonb, created_at timestamptz, updated_at timestamptz, content text)`,
    );
    const rows = [
      {
        id: "a",
        n: 2,
        visibility: { kind: "public" },
        tags: ["x"],
        blank: "\t\u00a0\ufeff",
        label: "O'Reilly",
        caseText: "MiXeD",
        nested: { caseText: "NeStEd" },
        literal: "%_\\' OR TRUE --",
      },
      {
        id: "b",
        n: 10,
        visibility: { kind: "participants", ids: ["viewer"] },
        tags: ["y"],
        scope: null,
        blank: "",
        caseText: "mixed",
        nested: { caseText: "other" },
      },
      {
        id: "c",
        n: "10",
        visibility: { kind: "private" },
        tags: ["z"],
        scope: "",
        blank: "word",
        caseText: 10,
      },
      {
        id: "d",
        n: false,
        visibility: { kind: "public" },
        tags: "x",
        scope: "internal",
        caseText: ["mixed"],
      },
      {
        id: "e",
        n: null,
        visibility: { kind: "public" },
        scope: " \t",
        blank: null,
        caseText: null,
      },
    ];
    for (const [i, row] of rows.entries()) {
      await session.query(
        `INSERT INTO predicate_nodes VALUES ($1, 'tenant', 'entry', $2::jsonb, $3::timestamptz, $3::timestamptz, '')`,
        [
          row.id,
          JSON.stringify(row),
          `2026-09-06T00:00:00.${String(i + 1).padStart(6, "0")}Z`,
        ],
      );
    }
    await session.query(
      `INSERT INTO predicate_nodes SELECT id, 'other', type, data, created_at, updated_at, content FROM predicate_nodes`,
    );
    await session.query(
      `INSERT INTO predicate_nodes SELECT id, namespace, 'other_type', data, created_at, updated_at, content FROM predicate_nodes WHERE namespace = 'tenant'`,
    );
    const list = (filter: CollectionPredicate, extra: CollectionQuery = {}) =>
      queryCollectionRecords(session, tables, definition, "tenant", {
        ...extra,
        filter,
      });
    const ids = async (filter: CollectionPredicate, extra?: CollectionQuery) =>
      (await list(filter, extra)).map((r) => r.id);
    assertEquals(
      await ids({
        or: [{ field: "visibility.kind", eq: "public" }, {
          field: "visibility.ids",
          overlaps: ["viewer"],
        }],
      }),
      ["a", "b", "d", "e"],
    );
    assertEquals(await ids({ field: "n", eq: 10 }), ["b"]);
    assertEquals(await ids({ field: "n", jsonEquals: 10 }), ["b"]);
    assertEquals(
      await ids({ field: "visibility", jsonEquals: { kind: "public" } }),
      ["a", "d", "e"],
    );
    assertEquals(await ids({ field: "tags", jsonEquals: ["x"] }), ["a"]);
    assertEquals(await ids({ field: "scope", jsonEquals: null }), ["b"]);
    assertEquals(await ids({ field: "n", eq: "10" }), ["c"]);
    assertEquals(await ids({ field: "n", in: [2, false] }), ["a", "d"]);
    assertEquals(await ids({ field: "n", gt: 2 }), ["b"]);
    assertEquals(await ids({ field: "n", gte: 2 }), ["a", "b"]);
    assertEquals(await ids({ field: "n", lt: 10 }), ["a"]);
    assertEquals(await ids({ field: "n", lte: 10 }), ["a", "b"]);
    assertEquals(await ids({ field: "id", gt: "c" }), ["d", "e"]);
    assertEquals(await ids({ field: "scope", exists: false }), ["a"]);
    assertEquals(await ids({ field: "scope", isNull: true }), ["b"]);
    assertEquals(await ids({ field: "scope", eq: null }), ["b"]);
    assertEquals(await ids({ field: "scope", ne: null }), ["a", "c", "d", "e"]);
    assertEquals(await ids({ field: "blank", isBlank: true }), ["a", "b"]);
    assertEquals(await ids({ field: "scope", isBlank: true }), ["c", "e"]);
    assertEquals(await ids({ field: "scope", isNull: false }), [
      "a",
      "c",
      "d",
      "e",
    ]);
    assertEquals(
      await ids({ not: { field: "visibility.kind", eq: "private" } }),
      ["a", "b", "d", "e"],
    );
    assertEquals(await ids({ field: "tags", overlaps: ["x", "y"] }), [
      "a",
      "b",
    ]);
    assertEquals(await ids({ field: "id", in: [] }), []);
    assertEquals(await ids({ field: "caseText", eqIgnoreCase: "MIXED" }), [
      "a",
      "b",
    ]);
    assertEquals(
      await ids({ field: "caseText", inIgnoreCase: ["MIXED", "OTHER"] }),
      ["a", "b"],
    );
    assertEquals(await ids({ field: "caseText", eqIgnoreCase: "10" }), []);
    assertEquals(
      await ids({ field: "caseText", eqIgnoreCase: " mixed " }),
      [],
    );
    assertEquals(
      await ids({ not: { field: "caseText", eqIgnoreCase: "mixed" } }),
      ["c", "d", "e"],
    );
    assertEquals(
      await ids({ field: "nested.caseText", inIgnoreCase: ["nested"] }),
      ["a"],
    );
    assertEquals(await ids({ field: "id", eqIgnoreCase: "A" }), ["a"]);
    assertEquals(await ids({ field: "caseText", inIgnoreCase: [] }), []);
    assertEquals(
      await ids({ field: "literal", eqIgnoreCase: "%_\\' OR TRUE --" }),
      ["a"],
    );
    assertEquals(await ids({ field: "literal", eqIgnoreCase: "%" }), []);
    assertEquals(await ids({ field: "literal", eqIgnoreCase: "_" }), []);
    assertEquals(
      await ids({
        or: [{ field: "namespace", eqIgnoreCase: "OTHER" }, {
          field: "id",
          eqIgnoreCase: "A",
        }],
      }),
      ["a"],
    );
    assertEquals(
      await ids({ field: "caseText", eqIgnoreCase: "mixed" }, {
        after: "a",
        limit: 1,
      }),
      ["b"],
    );
    assertEquals(await ids({ and: [] }), ["a", "b", "c", "d", "e"]);
    assertEquals(await ids({ or: [] }), []);
    assertEquals(await ids({ field: "label", eq: "O'Reilly" }), ["a"]);
    assertEquals(await ids({ field: "id", eq: "' OR TRUE --" }), []);
    assertEquals(
      await ids({
        or: [{ field: "namespace", eq: "other" }, { field: "id", eq: "a" }],
      }),
      ["a"],
    );
    assertEquals(
      await ids({ not: { field: "id", eq: "z" } }, {
        all: [{ filter: { field: "visibility.kind", eq: "public" } }],
        limit: 2,
      }),
      ["a", "d"],
    );
    assertEquals(
      await ids({ or: [{ field: "id", eq: "a" }, { field: "id", eq: "b" }] }, {
        where: { "visibility.kind": "public" },
        containsAny: { tags: ["x"] },
      }),
      ["a"],
    );
    const publicOnly: CollectionPredicate = {
      field: "visibility.kind",
      eq: "public",
    };
    assertEquals(await ids(publicOnly, { limit: 1, after: "a" }), ["d"]);
    assertEquals(
      await ids(publicOnly, {
        order: { field: "id", direction: "desc" },
        after: "e",
        limit: 1,
      }),
      ["d"],
    );
    assertEquals(await ids(publicOnly, { before: "e" }), ["a", "d"]);
    await assertRejects(
      () => list(publicOnly, { after: "c" }),
      RangeError,
      "current query scope",
    );
    // Column timestamps retain sub-millisecond precision, including cursor anchors.
    assertEquals(
      await ids({ field: "createdAt", gt: "2026-09-06T00:00:00.000002Z" }),
      ["c", "d", "e"],
    );
    assertEquals(
      await ids({ field: "createdAt", eq: "2026-09-06T00:00:00.000002Z" }),
      ["b"],
    );
    assertEquals(
      await ids({ and: [] }, {
        order: { field: "createdAt", direction: "asc" },
        after: "b",
        limit: 2,
      }),
      ["c", "d"],
    );
    const branch: CollectionPredicate = {
      or: [
        { field: "createdAt", lt: "2026-09-06T00:00:00.000002Z" },
        { field: "id", eq: "d" },
        { field: "createdAt", gt: "2026-09-06T00:00:00.000004Z" },
      ],
    };
    assertEquals(await ids(branch), ["a", "d", "e"]);
    // Equal timestamps require the same ID tie-breaker as cursor ordering.
    await session.query(
      "UPDATE predicate_nodes SET created_at = '2026-09-06T00:00:00.000003Z' WHERE id IN ('b', 'c', 'd')",
    );
    const beforeC: CollectionPredicate = {
      or: [
        { field: "createdAt", lt: "2026-09-06T00:00:00.000003Z" },
        {
          and: [{ field: "createdAt", eq: "2026-09-06T00:00:00.000003Z" }, {
            field: "id",
            lt: "c",
          }],
        },
      ],
    };
    assertEquals(await ids(beforeC), ["a", "b"]);
    assertEquals(
      await ids({ and: [] }, {
        order: { field: "createdAt", direction: "asc" },
        after: "b",
        limit: 2,
      }),
      ["c", "d"],
    );
    assertEquals(
      await ids({ and: [] }, {
        order: { field: "createdAt", direction: "desc" },
        after: "d",
        limit: 2,
      }),
      ["c", "b"],
    );
  } finally {
    await db.close();
  }
});

Deno.test("collection mutation filters match SQL JSON containment and null semantics", () => {
  const record = {
    metadata: { tenant: "a", flags: ["one", "two"] },
    tags: ["x", "y"],
    explicitNull: null,
    enabled: true,
    count: 2,
  };
  assertEquals(
    matchesCollectionFilter(
      { contains: { metadata: { tenant: "a" } } },
      record,
    ),
    true,
  );
  assertEquals(
    matchesCollectionFilter({ contains: { tags: ["x"] } }, record),
    true,
  );
  assertEquals(
    matchesCollectionFilter({ containsAny: { tags: ["z", "y"] } }, record),
    true,
  );
  assertEquals(
    matchesCollectionFilter(
      { filter: { field: "explicitNull", isNull: true } },
      record,
    ),
    true,
  );
  assertEquals(
    matchesCollectionFilter(
      { filter: { field: "missing", isNull: true } },
      record,
    ),
    false,
  );
  assertEquals(
    matchesCollectionFilter({ where: { missing: null } }, record),
    false,
  );
  assertEquals(
    matchesCollectionFilter({ where: { enabled: true } }, record),
    true,
  );
  assertEquals(
    matchesCollectionFilter({ where: { count: "2" } }, record),
    true,
  );
  assertEquals(
    matchesCollectionFilter({ filter: { field: "count", lt: "10" } }, record),
    false,
  );
  const timestamped = { createdAt: "2026-09-18T12:00:00.123456Z" };
  assertEquals(
    matchesCollectionFilter({
      filter: {
        field: "createdAt",
        eq: "2026-09-18T12:00:00.123456+00:00",
      },
    }, timestamped),
    true,
  );
  assertEquals(
    matchesCollectionFilter({
      filter: { field: "createdAt", gt: "2026-09-18T12:00:00.123457Z" },
    }, timestamped),
    false,
  );
});

Deno.test("collection predicates reject malformed, unbounded, and injectable structures", () => {
  const invalid: unknown[] = [
    {},
    { field: "id", wat: 1 },
    { field: "id", constructor: "x" },
    { field: "id", eq: "a", ne: "b" },
    { and: [], or: [] },
    { field: "id'); DROP TABLE nodes; --", eq: "a" },
    { field: "id", in: [undefined] },
    { field: "n", eq: NaN },
    { field: "n", gt: null },
    { field: "id", exists: 1 },
    { field: "id", in: Array(1001).fill("x") },
    { field: "id", eqIgnoreCase: 1 },
    { field: "id", inIgnoreCase: ["x", 1] },
    { field: "id", inIgnoreCase: Array(1001).fill("x") },
    { field: "createdAt", eqIgnoreCase: "2026-09-06" },
    { field: "updatedAt", inIgnoreCase: ["2026-09-06"] },
    { field: "n", jsonEquals: undefined },
    { field: "n", jsonEquals: NaN },
    { field: "n", jsonEquals: new Date() },
    { field: "n", jsonEquals: { value: undefined } },
    { field: "n", jsonEquals: [, 1] },
    {
      field: "n",
      jsonEquals: Object.defineProperty({}, "value", { get: () => 1 }),
    },
    { field: "n", jsonEquals: "x".repeat(1024 * 1024 + 1) },
  ];
  let deep: CollectionPredicate = { and: [] };
  for (let i = 0; i < 17; i++) deep = { not: deep };
  invalid.push(
    deep,
    { and: Array(256).fill({ and: [] }) },
    { and: new Array(2) },
    { field: "id", in: new Array(2) },
    Object.assign(Object.create({ field: "id" }), { eq: "a", extra: true }),
    {
      and: [{ field: "id", in: Array(600).fill("a") }, {
        field: "id",
        in: Array(600).fill("b"),
      }],
    },
  );
  for (const value of invalid) {
    assertThrows(
      () => compileCollectionPredicate(value as CollectionPredicate, []),
      TypeError,
    );
  }
  const params: unknown[] = [];
  const sql = compileCollectionPredicate(
    { field: "label", eq: "' OR TRUE --" },
    params,
  );
  assertEquals(sql.includes("' OR TRUE --"), false);
  assertEquals(params, [JSON.stringify("' OR TRUE --")]);
  const jsonParams: unknown[] = [];
  compileCollectionPredicate(
    { field: "metadata", jsonEquals: { z: 1, a: 2 } },
    jsonParams,
  );
  assertEquals(jsonParams, ['{"a":2,"z":1}']);
});
