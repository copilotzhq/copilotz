/** Private read-only baseline graph catalog predicate. This neither provisions
 * storage nor reads graph/content bodies. Use in the same fenced transaction as
 * the complete inventory, with a host deadline and no arbitrary concurrent DDL.
 * Catalog retention is bounded; this is not a database query-cost guarantee.
 */
import type { CollectionDefinition } from "../collections/definition.ts";
import { validateCollectionIndexes } from "../collections/indexes.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { captureOwnerGraphCollections } from "./startup-graph.ts";

type Table = Record<string, unknown> & {
  table_name: string;
  kind: string;
  persistence: string;
  partitioned: boolean;
  has_children: boolean;
  row_security: boolean;
  force_row_security: boolean;
  has_inheritance: boolean;
  has_rules: boolean;
};
type Column = Record<string, unknown> & {
  table_name: string;
  column_name: string;
  type_schema: string;
  type_name: string;
  type_modifier: number;
  not_null: boolean;
  generated: string;
  identity: string;
  inherited: number;
  baseline_collation: boolean;
  default_expression: string | null;
  default_bytes: number;
  default_is_now: boolean | null;
};
type Constraint = Record<string, unknown> & {
  table_name: string;
  kind: string;
  columns: string[];
  validated: boolean;
  deferrable: boolean;
  deferred: boolean;
  index_id: string;
  target_schema: string | null;
  target_table: string | null;
  target_columns: string[];
  delete_action: string;
  update_action: string;
  match_type: string;
};
type Index = Record<string, unknown> & {
  table_name: string;
  name: string;
  index_id: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  ready: boolean;
  live: boolean;
  immediate: boolean;
  exclusion: boolean;
  nulls_not_distinct: boolean;
  attribute_count: number;
  key_count: number;
  attribute_numbers: number[];
  keys: string[];
  has_expressions: boolean;
  predicate: string | null;
  predicate_bytes: number;
  expression_bytes: number;
  default_opclasses: boolean;
  default_collations: boolean;
};
const expectedColumns = {
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
const catalogLimit = 1000;
const expressionLimit = 8192;
function refuse(): never {
  throw Object.assign(new Error("Owner graph schema is incompatible."), {
    code: "owner_graph_schema_incompatible",
  });
}
function same(
  actual: readonly unknown[],
  expected: readonly unknown[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function exactIndex(
  index: Index,
  table: string,
  keys: readonly string[],
): boolean {
  return index.table_name === table && index.method === "btree" &&
    index.unique === true && index.valid === true && index.ready === true &&
    index.live === true && index.immediate === true &&
    index.exclusion === false &&
    index.nulls_not_distinct === false &&
    index.attribute_count === keys.length &&
    index.key_count === keys.length && Array.isArray(index.attribute_numbers) &&
    index.attribute_numbers.length === keys.length &&
    index.attribute_numbers.every((value) =>
      Number.isSafeInteger(value) && value > 0
    ) &&
    same(index.keys, keys) && index.has_expressions === false &&
    index.default_opclasses === true && index.default_collations === true;
}
function sourcePredicate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const tokens =
    value.match(/"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[()]|[^\s]/g) ?? [];
  if (tokens.length > 64) return false;
  let index = 0;
  const keyword = (word: string) => tokens[index]?.toUpperCase() === word;
  const expression = (depth: number): string[] | null => {
    if (depth > 16) return null;
    const atom = (): string[] | null => {
      if (tokens[index] === "(") {
        index++;
        const inner = expression(depth + 1);
        if (!inner || tokens[index++] !== ")") return null;
        return inner;
      }
      const name = tokens[index++];
      const column = name === '"source_type"'
        ? "source_type"
        : name === '"source_id"'
        ? "source_id"
        : name;
      if (column !== "source_type" && column !== "source_id") return null;
      for (const word of ["IS", "NOT", "NULL"]) {
        if (!keyword(word)) return null;
        index++;
      }
      return [column];
    };
    const columns = atom();
    if (!columns) return null;
    while (keyword("AND")) {
      index++;
      const other = atom();
      if (!other) return null;
      columns.push(...other);
      if (columns.length > 2) return null;
    }
    return columns;
  };
  const columns = expression(0);
  // Tokens keep quoted identifiers intact: a function with a deceptively
  // concatenated name cannot become the expected two-column conjunction.
  return index === tokens.length && columns !== null &&
    same(columns, ["source_type", "source_id"]);
}

export async function validateOwnerGraphSchema(
  tx: SqlExecutor,
  schemaName: string,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  // Snapshot before any async boundary; hooks/defaults/commands never execute.
  const captured = captureOwnerGraphCollections(definitions);
  let remaining = catalogLimit;
  async function rows<T extends Record<string, unknown>>(
    sql: string,
  ): Promise<T[]> {
    const result = (await tx.query<T>(sql, [schema, remaining + 1])).rows;
    if (result.length > remaining) refuse();
    remaining -= result.length;
    return result;
  }
  const tables = await rows<Table>(
    `SELECT tab.relname AS table_name, tab.relkind AS kind,
       tab.relpersistence AS persistence, tab.relispartition AS partitioned,
       tab.relhassubclass AS has_children, tab.relrowsecurity AS row_security,
       tab.relforcerowsecurity AS force_row_security, tab.relhasrules AS has_rules,
       EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh
         WHERE inh.inhrelid=tab.oid OR inh.inhparent=tab.oid) AS has_inheritance
     FROM pg_catalog.pg_class tab
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     WHERE ns.nspname=$1 AND tab.relname IN ('nodes','edges') LIMIT $2`,
  );
  if (
    tables.length !== 2 ||
    !["nodes", "edges"].every((table) =>
      tables.some((row) =>
        row.table_name === table && row.kind === "r" &&
        row.persistence === "p" && row.partitioned === false &&
        row.has_children === false && row.row_security === false &&
        row.force_row_security === false && row.has_inheritance === false &&
        row.has_rules === false
      )
    )
  ) refuse();
  const columns = await rows<Column>(
    `SELECT tab.relname AS table_name, attr.attname AS column_name,
       typens.nspname AS type_schema, typ.typname AS type_name,
       attr.atttypmod AS type_modifier, attr.attnotnull AS not_null,
       attr.attgenerated AS generated, attr.attidentity AS identity,
       attr.attinhcount AS inherited,
       (CASE WHEN attr.atttypid='pg_catalog.text'::regtype
         THEN attr.attcollation='pg_catalog."default"'::regcollation::oid
         ELSE attr.attcollation=0 END) AS baseline_collation,
       COALESCE(octet_length(pg_catalog.pg_get_expr(def.adbin,def.adrelid)),0)::int AS default_bytes,
       CASE WHEN octet_length(pg_catalog.pg_get_expr(def.adbin,def.adrelid)) <= ${expressionLimit}
         THEN pg_catalog.pg_get_expr(def.adbin,def.adrelid) ELSE NULL END AS default_expression,
       (substring(def.adbin::text from '^\\{FUNCEXPR :funcid ([0-9]+) ')::oid =
         'pg_catalog.now()'::regprocedure::oid) AS default_is_now
     FROM pg_catalog.pg_attribute attr
     JOIN pg_catalog.pg_class tab ON tab.oid=attr.attrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     JOIN pg_catalog.pg_type typ ON typ.oid=attr.atttypid
     JOIN pg_catalog.pg_namespace typens ON typens.oid=typ.typnamespace
     LEFT JOIN pg_catalog.pg_attrdef def ON def.adrelid=attr.attrelid AND def.adnum=attr.attnum
     WHERE ns.nspname=$1 AND tab.relname IN ('nodes','edges')
       AND attr.attnum > 0 AND NOT attr.attisdropped LIMIT $2`,
  );
  if (columns.length !== 18) refuse();
  const seenColumns = new Set<string>();
  for (const column of columns) {
    const table =
      expectedColumns[column.table_name as keyof typeof expectedColumns] as
        | Record<string, readonly [string, boolean]>
        | undefined;
    const expected = table?.[column.column_name];
    const key = `${column.table_name}.${column.column_name}`;
    const timestamp = column.column_name === "created_at" ||
      column.column_name === "updated_at";
    if (
      !expected || seenColumns.has(key) ||
      column.type_schema !== "pg_catalog" ||
      column.type_name !== expected[0] || column.not_null !== expected[1] ||
      column.type_modifier !== -1 || column.generated !== "" ||
      column.identity !== "" ||
      column.inherited !== 0 || column.baseline_collation !== true ||
      !Number.isSafeInteger(column.default_bytes) ||
      column.default_bytes < 0 || column.default_bytes > expressionLimit ||
      (timestamp
        ? column.default_is_now !== true ||
          !["now()", "pg_catalog.now()"].includes(
            column.default_expression ?? "",
          )
        : column.default_expression !== null || column.default_bytes !== 0)
    ) refuse();
    seenColumns.add(key);
  }
  const constraints = await rows<Constraint>(
    `SELECT tab.relname AS table_name, con.contype AS kind,
       con.convalidated AS validated, con.condeferrable AS deferrable,
       con.condeferred AS deferred, con.conindid::text AS index_id,
       ARRAY(SELECT attr.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS key(num,ord)
         JOIN pg_catalog.pg_attribute attr ON attr.attrelid=con.conrelid AND attr.attnum=key.num ORDER BY key.ord) AS columns,
       targetns.nspname AS target_schema, target.relname AS target_table,
       ARRAY(SELECT attr.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS key(num,ord)
         JOIN pg_catalog.pg_attribute attr ON attr.attrelid=con.confrelid AND attr.attnum=key.num ORDER BY key.ord) AS target_columns,
       con.confdeltype AS delete_action, con.confupdtype AS update_action, con.confmatchtype AS match_type
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class tab ON tab.oid=con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     LEFT JOIN pg_catalog.pg_class target ON target.oid=con.confrelid
     LEFT JOIN pg_catalog.pg_namespace targetns ON targetns.oid=target.relnamespace
     WHERE ns.nspname=$1 AND tab.relname IN ('nodes','edges') AND con.contype IN ('p','f') LIMIT $2`,
  );
  const indexes = await rows<Index>(
    `SELECT tab.relname AS table_name, idx.relname AS name, idx.oid::text AS index_id,
       am.amname AS method, i.indisunique AS unique, i.indisprimary AS primary,
       i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
       i.indimmediate AS immediate, i.indisexclusion AS exclusion,
       i.indnullsnotdistinct AS nulls_not_distinct,
       i.indnatts::int AS attribute_count, i.indnkeyatts::int AS key_count,
       i.indkey::smallint[] AS attribute_numbers, i.indexprs IS NOT NULL AS has_expressions,
       COALESCE(octet_length(pg_catalog.pg_get_expr(i.indexprs,i.indrelid)),0)::int AS expression_bytes,
       ARRAY(SELECT attr.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(num,ord)
         JOIN pg_catalog.pg_attribute attr ON attr.attrelid=i.indrelid AND attr.attnum=key.num ORDER BY key.ord) AS keys,
       COALESCE(octet_length(pg_catalog.pg_get_expr(i.indpred,i.indrelid)),0)::int AS predicate_bytes,
       CASE WHEN octet_length(pg_catalog.pg_get_expr(i.indpred,i.indrelid)) <= ${expressionLimit}
         THEN pg_catalog.pg_get_expr(i.indpred,i.indrelid) ELSE NULL END AS predicate,
       NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS spec(oid)
         JOIN pg_catalog.pg_opclass opc ON opc.oid=spec.oid
         JOIN pg_catalog.pg_namespace opcns ON opcns.oid=opc.opcnamespace
         WHERE opcns.nspname <> 'pg_catalog' OR opc.opcname <> 'text_ops'
           OR opc.opcintype <> 'pg_catalog.text'::regtype OR NOT opc.opcdefault OR opc.opcmethod <> idx.relam) AS default_opclasses,
       NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[],i.indcollation::oid[]) AS spec(num,collation_oid)
         JOIN pg_catalog.pg_attribute attr ON attr.attrelid=i.indrelid AND attr.attnum=spec.num
         WHERE spec.collation_oid <> attr.attcollation) AS default_collations
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
     JOIN pg_catalog.pg_class tab ON tab.oid=i.indrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     JOIN pg_catalog.pg_am am ON am.oid=idx.relam
     WHERE ns.nspname=$1 AND tab.relname IN ('nodes','edges') LIMIT $2`,
  );
  if (
    indexes.some((index) =>
      !Number.isSafeInteger(index.predicate_bytes) ||
      index.predicate_bytes < 0 || index.predicate_bytes > expressionLimit ||
      !Number.isSafeInteger(index.expression_bytes) ||
      index.expression_bytes < 0 || index.expression_bytes > expressionLimit
    )
  ) refuse();
  if (constraints.length !== 4) refuse();
  for (const table of ["nodes", "edges"]) {
    const primary = constraints.find((constraint) =>
      constraint.table_name === table && constraint.kind === "p"
    );
    const index = primary &&
      indexes.find((index) => index.index_id === primary.index_id);
    if (
      !primary || !same(primary.columns, ["id"]) ||
      primary.validated !== true ||
      primary.deferrable !== false || primary.deferred !== false || !index ||
      !exactIndex(index, table, ["id"]) || index.primary !== true ||
      index.predicate !== null || index.predicate_bytes !== 0
    ) refuse();
  }
  for (const column of ["source_node_id", "target_node_id"]) {
    if (
      !constraints.some((constraint) =>
        constraint.table_name === "edges" && constraint.kind === "f" &&
        same(constraint.columns, [column]) &&
        constraint.target_schema === schema &&
        constraint.target_table === "nodes" &&
        same(constraint.target_columns, ["id"]) &&
        constraint.validated === true &&
        constraint.deferrable === false && constraint.deferred === false &&
        constraint.delete_action === "c" &&
        constraint.update_action === "a" && constraint.match_type === "s"
      )
    ) refuse();
  }
  const identity = (index: Index) =>
    exactIndex(index, "nodes", [
      "namespace",
      "type",
      "source_type",
      "source_id",
    ]) &&
    index.primary === false && sourcePredicate(index.predicate);
  const named = indexes.find((index) =>
    index.table_name === "nodes" && index.name === "nodes_identity_unique_idx"
  );
  if ((named && !identity(named)) || !indexes.some(identity)) refuse();
  // The existing declared-index checker recognizes its current generated SQL
  // equivalence, not arbitrary index semantics. In particular it does not
  // currently verify opclasses or INCLUDE attributes. The stronger exactness
  // above covers the PK/source indexes relied on for this graph predicate.
  // Its second metadata read is retained only after the bounded preflight;
  // caller fencing/DDL exclusion must hold across both reads.
  await validateCollectionIndexes(tx, schema, captured);
}
