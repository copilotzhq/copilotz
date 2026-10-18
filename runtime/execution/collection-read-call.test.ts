import { assertEquals, assertThrows } from "@std/assert";
import {
  parseOwnerCollectionReadRequest,
  parseOwnerCollectionReadScope,
} from "./collection-read-call.ts";

Deno.test("ordinary read requests are closed detached JSON with bounded fields", () => {
  const original = {
    collectionAlias: "notes",
    operation: "list",
    query: {
      where: { status: "ok" },
      all: [{ where: { tenant: "a" } }],
      limit: 1,
    },
  };
  const parsed = parseOwnerCollectionReadRequest(original);
  original.query.where.status = "changed";
  assertEquals((parsed as typeof original).query.where.status, "ok");
  assertEquals(
    parseOwnerCollectionReadRequest({
      collectionAlias: "notes",
      operation: "get",
      id: "a",
    }),
    { collectionAlias: "notes", operation: "get", id: "a" },
  );
  assertEquals(
    parseOwnerCollectionReadRequest({
      collectionAlias: "notes",
      operation: "aggregate",
      query: { metrics: { n: { op: "count" } } },
    }).operation,
    "aggregate",
  );
  const list = (query: unknown) => ({
    collectionAlias: "notes",
    operation: "list",
    query,
  });
  for (
    const bad of [
      { ...original, namespace: "other" },
      { ...original, identity: {} },
      { ...original, operation: "query" },
      { collectionAlias: "notes", operation: "get", id: "a", query: {} },
      { collectionAlias: "notes", operation: "get", id: " a " },
      list({ include: ["private"] }),
      list({ text: "secret" }),
      list({ select: ["private"] }),
      list({ namespace: "other" }),
      list({ limit: 1001 }),
      list({ limit: 0 }),
      list({ order: { field: "id", sql: "DROP TABLE nodes" } }),
      list({ where: { id: 1 } }),
      list({ where: { nested: {} } }),
      list({ all: [{ namespace: "other" }] }),
      list({ all: new Array(1) }),
      list({ containsAny: { tags: "x" } }),
      list({ after: "x".repeat(513) }),
      list({ where: { big: "x".repeat(65536) } }),
      {
        collectionAlias: "notes",
        operation: "aggregate",
        query: { metrics: { n: { op: "count", sql: "x" } } },
      },
      {
        collectionAlias: "notes",
        operation: "aggregate",
        query: {
          metrics: { n: { op: "count" } },
          groupBy: [{ field: "time", interval: "day", sql: "x" }],
        },
      },
    ]
  ) assertThrows(() => parseOwnerCollectionReadRequest(bad));
  let accessed = false;
  assertThrows(() =>
    parseOwnerCollectionReadRequest({
      ...original,
      get query() {
        accessed = true;
        return {};
      },
    })
  );
  assertEquals(accessed, false);
});

Deno.test("ordinary read policy scope cannot select namespace, pagination or columns", () => {
  assertEquals(parseOwnerCollectionReadScope({}), {});
  for (
    const bad of [
      undefined,
      null,
      false,
      { namespace: "other" },
      { limit: 1 },
      { select: ["id"] },
      { all: [] },
    ]
  ) {
    assertThrows(() => parseOwnerCollectionReadScope(bad));
  }
  const value = { where: { state: "public" } };
  const captured = parseOwnerCollectionReadScope(value);
  value.where.state = "private";
  assertEquals(captured, { where: { state: "public" } });
});
