import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/definition.ts";
import type { SqlExecutor } from "../events/session.ts";
import { validateOwnerGraphSchema } from "./startup-graph-schema.ts";

type Row = Record<string, unknown>;
function fixture() {
  const tables: Row[] = ["nodes", "edges"].map((table_name) => ({
    table_name,
    kind: "r",
    persistence: "p",
    partitioned: false,
    has_children: false,
    row_security: false,
    force_row_security: false,
    has_inheritance: false,
    has_rules: false,
  }));
  const columnTypes = {
    nodes: {
      id: ["text", true],
      namespace: ["text", true],
      type: ["text", true],
      name: ["text", true],
      content: ["text", false],
      data: ["jsonb", false],
      source_type: ["text", false],
      source_id: ["text", false],
      created_at: ["timestamptz", true],
      updated_at: ["timestamptz", true],
    },
    edges: {
      id: ["text", true],
      namespace: ["text", true],
      source_node_id: ["text", true],
      target_node_id: ["text", true],
      type: ["text", true],
      data: ["jsonb", false],
      weight: ["float8", false],
      created_at: ["timestamptz", true],
    },
  } as const;
  const columns: Row[] = Object.entries(columnTypes).flatMap((
    [table_name, fields],
  ) =>
    Object.entries(fields).map(([column_name, [type_name, not_null]]) => {
      const timestamp = type_name === "timestamptz";
      return {
        table_name,
        column_name,
        type_schema: "pg_catalog",
        type_name,
        type_modifier: -1,
        not_null,
        generated: "",
        identity: "",
        inherited: 0,
        baseline_collation: true,
        default_expression: timestamp ? "now()" : null,
        default_bytes: timestamp ? 5 : 0,
        default_is_now: timestamp ? true : null,
      };
    })
  );
  const constraints: Row[] = ["nodes", "edges"].map((table_name, index) => ({
    table_name,
    kind: "p",
    columns: ["id"],
    validated: true,
    deferrable: false,
    deferred: false,
    index_id: String(index + 1),
    target_schema: null,
    target_table: null,
    target_columns: [],
    delete_action: " ",
    update_action: " ",
    match_type: " ",
  }));
  for (const column of ["source_node_id", "target_node_id"]) {
    constraints.push({
      table_name: "edges",
      kind: "f",
      columns: [column],
      validated: true,
      deferrable: false,
      deferred: false,
      index_id: "1",
      target_schema: "public",
      target_table: "nodes",
      target_columns: ["id"],
      delete_action: "c",
      update_action: "a",
      match_type: "s",
    });
  }
  const index = (
    table_name: string,
    name: string,
    index_id: string,
    keys: string[],
    primary: boolean,
    predicate: string | null,
  ): Row => ({
    table_name,
    name,
    index_id,
    keys,
    primary,
    predicate,
    method: "btree",
    unique: true,
    valid: true,
    ready: true,
    live: true,
    immediate: true,
    exclusion: false,
    nulls_not_distinct: false,
    attribute_count: keys.length,
    key_count: keys.length,
    attribute_numbers: keys.map((_, index) => index + 1),
    has_expressions: false,
    expression_bytes: 0,
    predicate_bytes: predicate?.length ?? 0,
    default_opclasses: true,
    default_collations: true,
  });
  const indexes = [
    index("nodes", "nodes_pkey", "1", ["id"], true, null),
    index("edges", "edges_pkey", "2", ["id"], true, null),
    index(
      "nodes",
      "nodes_identity_unique_idx",
      "3",
      ["namespace", "type", "source_type", "source_id"],
      false,
      "((source_type IS NOT NULL) AND (source_id IS NOT NULL))",
    ),
  ];
  const declared: Row[] = [];
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  let onFirstRead: (() => void) | undefined;
  const tx: SqlExecutor = {
    async query<T extends Row>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      assert.match(sql.trimStart(), /^SELECT/);
      assert.equal(params?.[0], "public");
      if (calls.length === 1) onFirstRead?.();
      const rows = sql.includes("tab.relpersistence")
        ? tables
        : sql.includes("attr.atttypmod")
        ? columns
        : sql.includes("FROM pg_catalog.pg_constraint con")
        ? constraints
        : sql.includes("i.indislive")
        ? indexes
        : declared;
      return { rows: rows as T[] };
    },
  };
  return {
    tables,
    columns,
    constraints,
    indexes,
    declared,
    calls,
    tx,
    setOnFirstRead(value: () => void) {
      onFirstRead = value;
    },
  };
}

test("plain graph catalog baseline is checked without writes or graph reads", async () => {
  const f = fixture();
  await validateOwnerGraphSchema(f.tx, "public", []);
  assert.equal(f.calls.length, 4);
  for (const { sql, params } of f.calls) {
    assert.ok(sql.includes("LIMIT $2"));
    assert.ok(typeof params?.[1] === "number" && (params[1] as number) <= 1001);
    assert.ok(
      !/content_bodies|content_body_parts|SELECT \*|CREATE |ALTER |DROP /.test(
        sql,
      ),
    );
  }
});

test("source predicate preserves quoted identifier token boundaries", async () => {
  const f = fixture();
  f.indexes[2].predicate = '"source_typeISNOTNULLANDsource_idISNOTNULL"()';
  await assert.rejects(
    () => validateOwnerGraphSchema(f.tx, "public", []),
    /graph schema is incompatible/,
  );
});

test("nonbaseline tables columns defaults and collations are refused", async () => {
  for (
    const patch of [
      { kind: "v" },
      { persistence: "u" },
      { partitioned: true },
      { has_children: true },
      { row_security: true },
      { force_row_security: true },
      { has_inheritance: true },
      { has_rules: true },
    ]
  ) {
    const f = fixture();
    Object.assign(f.tables[0], patch);
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
  for (
    const patch of [
      { type_schema: "app" },
      { type_name: "varchar" },
      { type_modifier: 30 },
      { not_null: false },
      { generated: "s" },
      { identity: "a" },
      { inherited: 1 },
      { baseline_collation: false },
      { default_expression: "'x'::text", default_bytes: 9 },
    ]
  ) {
    const f = fixture();
    Object.assign(f.columns[0], patch);
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
  for (
    const patch of [
      { default_expression: null, default_bytes: 0 },
      { default_expression: "clock_timestamp()" },
      { default_is_now: false },
      { default_bytes: 8193 },
    ]
  ) {
    const f = fixture();
    Object.assign(
      f.columns.find((column) => column.column_name === "created_at")!,
      patch,
    );
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
  const missing = fixture();
  missing.columns.pop();
  await assert.rejects(() =>
    validateOwnerGraphSchema(missing.tx, "public", [])
  );
});

test("every relied-on index must be exact live immediate plain btree", async () => {
  for (const position of [0, 1, 2]) {
    for (
      const patch of [
        { method: "hash" },
        { unique: false },
        { valid: false },
        { ready: false },
        { live: false },
        { immediate: false },
        { exclusion: true },
        { nulls_not_distinct: true },
        { attribute_count: 99 },
        { key_count: 99 },
        { attribute_numbers: [0] },
        { has_expressions: true },
        { default_opclasses: false },
        { default_collations: false },
      ]
    ) {
      const f = fixture();
      Object.assign(f.indexes[position], patch);
      await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
    }
  }
});

test("partial primary keys and weakened or extra source predicates are refused", async () => {
  for (
    const predicate of [
      null,
      "source_type IS NOT NULL",
      "source_type IS NOT NULL OR source_id IS NOT NULL",
      "source_type IS NOT NULL AND source_id IS NOT NULL AND true",
      "source_typeISNOTNULLANDsource_idISNOTNULL",
      "(source_type IS NOT NULL) AND (source_id IS NOT NULL) OR true",
    ]
  ) {
    const f = fixture();
    f.indexes[2].predicate = predicate;
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
  const f = fixture();
  f.indexes[0].predicate = "true";
  await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
});

test("equivalent source index may be operator-named but conflicting managed name refuses", async () => {
  const f = fixture();
  f.indexes[2].name = "operator_identity";
  await validateOwnerGraphSchema(f.tx, "public", []);
  f.indexes.push({
    ...f.indexes[2],
    name: "nodes_identity_unique_idx",
    valid: false,
  });
  await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
});

test("endpoint foreign keys bind exact schema type keys and cascade contract", async () => {
  for (
    const patch of [
      { target_schema: "foreign" },
      { target_table: "other" },
      { target_columns: ["namespace"] },
      { columns: ["source_node_id", "namespace"] },
      { validated: false },
      { deferrable: true },
      { deferred: true },
      { delete_action: "a" },
      { update_action: "c" },
      { match_type: "f" },
    ]
  ) {
    const f = fixture();
    Object.assign(f.constraints[2], patch);
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
});

test("catalog retention and expressions are bounded before declared-index reads", async () => {
  const full = fixture();
  full.indexes.push(...Array(1000).fill(full.indexes[2]));
  await assert.rejects(() => validateOwnerGraphSchema(full.tx, "public", []));
  assert.equal(full.calls.length, 4);
  for (const patch of [{ predicate_bytes: 8193 }, { expression_bytes: 8193 }]) {
    const f = fixture();
    f.indexes.push({ ...f.indexes[2], ...patch });
    await assert.rejects(() => validateOwnerGraphSchema(f.tx, "public", []));
  }
});

test("declared Collection indexes must physically exist after bounded preflight", async () => {
  const definition = defineCollection({
    name: "note",
    schema: { type: "object", properties: { title: { type: "string" } } },
    indexes: ["title"],
  });
  const missing = fixture();
  await assert.rejects(
    () => validateOwnerGraphSchema(missing.tx, "public", [definition]),
    /Collection indexes missing/,
  );
  assert.equal(missing.calls.length, 5);
  const present = fixture();
  present.declared.push({
    name: "operator_note_title",
    method: "btree",
    unique: false,
    nulls_not_distinct: false,
    valid: true,
    ready: true,
    keys: ["namespace", "data ->> 'title'", "id"],
    predicate: "type = 'note'::text",
  });
  await validateOwnerGraphSchema(present.tx, "public", [definition]);
});

test("definitions are detached before any asynchronous catalog read", async () => {
  const definition = defineCollection({
    name: "note",
    schema: { type: "object", properties: { title: { type: "string" } } },
    indexes: [],
  });
  const f = fixture();
  f.setOnFirstRead(() => (definition.indexes as unknown[]).push("title"));
  await validateOwnerGraphSchema(f.tx, "public", [definition]);
  assert.equal(
    f.calls.length,
    4,
    "later mutation must not add a declaration to the captured check",
  );
});
