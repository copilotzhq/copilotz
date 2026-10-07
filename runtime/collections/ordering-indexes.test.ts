import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineCollection } from "./definition.ts";
import {
  provisionCollectionIndexes,
  validateCollectionIndexes,
} from "./indexes.ts";
import { queryCollectionRecords } from "./query.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

const definition = defineCollection({
  name: "ordered_item",
  schema: {
    type: "object",
    properties: {
      group: { type: "string" },
      rank: { type: ["number", "null"] },
      enabled: { type: ["boolean", "null"] },
      details: {
        type: "object",
        properties: { priority: { type: "integer" } },
      },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  indexes: [["group", "rank"], "enabled", "details.priority", {
    fields: "tags",
    type: "gin",
  }, { fields: "createdAt", type: "brin" }],
});

async function verify(url: string) {
  const db = await createTestDatabase({ url });
  const schema = "ordering_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const tables = createCoreTableNames(schema);
  try {
    await provisionCopilotzSchema(db, schema);
    await assertRejects(
      () => validateCollectionIndexes(db, schema, [definition]),
      Error,
      "indexes missing",
    );
    await provisionCollectionIndexes(db, schema, [definition], {
      concurrently: url !== ":memory:",
    });
    await provisionCollectionIndexes(db, schema, [definition]);
    await validateCollectionIndexes(db, schema, [definition]);
    await Promise.all([
      provisionCollectionIndexes(db, schema, [definition]),
      provisionCollectionIndexes(db, schema, [definition]),
    ]);
    const physical = (await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname LIKE 'collection_idx_%' ORDER BY indexname`,
      [schema],
    )).rows;
    assertEquals(
      physical.length,
      5,
      "repeated provisioning does not duplicate indexes",
    );
    // A host may already have provisioned the exact index under its own name.
    const renamed = physical[1].indexname;
    await db.query(
      `ALTER INDEX "${schema}"."${renamed}" RENAME TO "operator_owned_index"`,
    );
    await provisionCollectionIndexes(db, schema, [definition]);
    await validateCollectionIndexes(db, schema, [definition]);
    assertEquals(
      Number(
        (await db.query(
          `SELECT count(*) AS count FROM pg_indexes WHERE schemaname=$1 AND (indexname LIKE 'collection_idx_%' OR indexname='operator_owned_index')`,
          [schema],
        )).rows[0].count,
      ),
      5,
    );
    const altered = physical[0].indexname;
    await db.query(`DROP INDEX "${schema}"."${altered}"`);
    await db.query(`CREATE INDEX "${altered}" ON ${tables.nodes}(namespace)`);
    await assertRejects(
      () => validateCollectionIndexes(db, schema, [definition]),
      Error,
      "differs from its declaration",
    );
    await assertRejects(
      () => provisionCollectionIndexes(db, schema, [definition]),
      Error,
      "differs from its declaration",
    );
    await db.query(`DROP INDEX "${schema}"."${altered}"`);
    await provisionCollectionIndexes(db, schema, [definition]);

    const add = (
      id: string,
      data: unknown,
      namespace = "tenant",
      type = definition.name,
    ) =>
      db.query(
        `INSERT INTO ${tables.nodes}(id,namespace,type,name,data) VALUES($1,$2,$3,$1,$4::jsonb)`,
        [id, namespace, type, JSON.stringify(data)],
      );
    for (
      const [id, rank] of [
        ["n9", 9],
        ["n10", 10],
        ["n99", 99],
        ["n100", 100],
        ["n-2", -2],
        ["n10b", 10],
        ["null", null],
      ] as const
    ) {
      await add(id, {
        group: "small",
        rank,
        enabled: rank === 10,
        details: { priority: rank ?? 0 },
      });
    }
    await add("missing", { group: "small" });
    const ids = async (query: Parameters<typeof queryCollectionRecords>[4]) =>
      (await queryCollectionRecords(db, tables, definition, "tenant", {
        where: { group: "small" },
        ...query,
      })).map((r) => r.id);
    const asc = { field: "rank", direction: "asc" } as const;
    const desc = { field: "rank", direction: "desc" } as const;
    const expected = [
      "n-2",
      "n9",
      "n10",
      "n10b",
      "n99",
      "n100",
      "missing",
      "null",
    ];
    assertEquals(await ids({ order: asc }), expected);
    assertEquals(await ids({ order: desc }), [...expected].reverse());
    for (const order of [asc, desc]) {
      const all = order === asc ? expected : [...expected].reverse();
      for (let i = 0; i < all.length; i++) {
        assertEquals(await ids({ order, after: all[i] }), all.slice(i + 1));
        assertEquals(await ids({ order, before: all[i] }), all.slice(0, i));
      }
    }
    assertEquals(
      await ids({ order: desc, filter: { field: "rank", gt: 0 }, limit: 1 }),
      ["n100"],
    );
    assertEquals(
      await ids({
        order: { field: "details.priority", direction: "asc" },
        limit: 1,
      }),
      ["n-2"],
    );
    assertEquals(
      await ids({
        order: { field: "enabled" },
        filter: { field: "enabled", eq: true },
      }),
      ["n10", "n10b"],
    );
    await assertRejects(
      () => ids({ order: { field: "undeclared" } }),
      TypeError,
      "must declare one scalar type",
    );
    await assertRejects(
      () => ids({ order: { field: "tags" } }),
      TypeError,
      "must declare one scalar type",
    );
    await assertRejects(
      () => ids({ order: { field: "rank); DROP TABLE nodes;--" } }),
      TypeError,
      "Invalid collection field",
    );
    await assertRejects(
      () => ids({ order: { field: "rank", direction: "wrong" as never } }),
      TypeError,
      "Invalid collection order",
    );
    // Large JSON numbers stay precise in the SQL cursor even if the JS row decoder rounds them.
    await db.query(
      `INSERT INTO ${tables.nodes}(id,namespace,type,name,data) VALUES
      ('large-a','tenant','ordered_item','a','{"group":"large","rank":9007199254740992}'),
      ('large-b','tenant','ordered_item','b','{"group":"large","rank":9007199254740993}'),
      ('large-c','tenant','ordered_item','c','{"group":"large","rank":9007199254740994}')`,
    );
    assertEquals(
      await ids({ where: { group: "large" }, order: asc, after: "large-b" }),
      ["large-c"],
    );
    assertEquals(
      await ids({ where: { group: "large" }, order: asc, before: "large-b" }),
      ["large-a"],
    );
    // A realistic ordered LIMIT must use the compound expression index without sorting.
    await db.query(`INSERT INTO ${tables.nodes}(id,namespace,type,name,data)
      SELECT 'bulk-'||i,'tenant','ordered_item','bulk',jsonb_build_object('group','bulk','rank',i)
      FROM generate_series(1,10000) i`);
    await db.query(`ANALYZE ${tables.nodes}`);
    let plan: unknown;
    const tracing = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        plan = (await db.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          params,
        )).rows;
        return await db.query<T>(sql, params);
      },
    };
    const top = await queryCollectionRecords(
      tracing,
      tables,
      definition,
      "tenant",
      { where: { group: "bulk" }, order: desc, limit: 1 },
    );
    assertEquals(top[0].id, "bulk-10000");
    const text = JSON.stringify(plan);
    assert(text.includes("collection_idx_"), text);
    assert(!text.includes('"Node Type":"Sort"'), text);
    console.log(
      JSON.stringify({
        backend: url === ":memory:" ? "PGlite" : "PostgreSQL",
        rows: 10000,
        indexUsed: true,
        sort: false,
      }),
    );
    const unique = defineCollection({
      name: "unique_item",
      schema: { type: "object", properties: { key: { type: "string" } } },
      indexes: [{ fields: "key", unique: true }],
    });
    await provisionCollectionIndexes(db, schema, [unique]);
    await add("u1", { key: "same" }, "one", "unique_item");
    await add("u2", { key: "same" }, "two", "unique_item");
    await add("u3", { key: "same" }, "one", "other_type");
    await assertRejects(() => add("u4", { key: "same" }, "one", "unique_item"));
    const duplicates = defineCollection({ ...unique, name: "duplicates" });
    await add("d1", { key: "same" }, "one", "duplicates");
    await add("d2", { key: "same" }, "one", "duplicates");
    await assertRejects(() =>
      provisionCollectionIndexes(db, schema, [duplicates])
    );
    assertEquals(
      Number(
        (await db.query(
          `SELECT count(*) AS count FROM ${tables.nodes} WHERE type='duplicates'`,
        )).rows[0].count,
      ),
      2,
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}
Deno.test("typed ordering, keyset cursors and declared indexes work together in PGlite", () =>
  verify(":memory:"));
const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "typed ordering, keyset cursors and declared indexes work together in PostgreSQL",
  ignore: !postgres,
  fn: () => verify(postgres!),
});
