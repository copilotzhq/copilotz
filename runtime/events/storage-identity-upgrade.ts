import { readyContentBodyIndexStatement } from "../content/catalog-schema.ts";
import { STORAGE_IDENTITY_COLUMNS } from "./storage-identity.ts";
/** Storage changes in the single drained v13 -> v14 transaction. */
import type { SqlExecutor } from "./session.ts";
import { createCoreTableNames, quoteEventIdentifier } from "./schema.ts";

export async function upgradeStorageIdentity(
  tx: SqlExecutor,
  schema: string,
): Promise<void> {
  const tables = createCoreTableNames(schema);
  const qualified = (table: string) =>
    `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
  // Drop and restore FKs around collation/index rewrites. Preserve their exact
  // actions and names; node references alone acquire the namespace component.
  const foreignKeys = (await tx.query<{
    table_name: string;
    name: string;
    definition: string;
    node_column: string | null;
  }>(
    `SELECT c.relname AS table_name,k.conname AS name,
       pg_get_constraintdef(k.oid) AS definition,
       CASE WHEN target.oid=$2::regclass AND cardinality(k.conkey)=1
         THEN a.attname ELSE NULL END AS node_column
     FROM pg_constraint k
     JOIN pg_class c ON c.oid=k.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_class target ON target.oid=k.confrelid
     LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.conkey[1]
     WHERE n.nspname=$1 AND k.contype='f' ORDER BY c.relname,k.conname`,
    [schema, tables.nodes],
  )).rows;
  for (const key of foreignKeys) {
    await tx.query(
      `ALTER TABLE ${qualified(key.table_name)} DROP CONSTRAINT ${
        quoteEventIdentifier(key.name)
      }`,
    );
  }
  await tx.query(`ALTER TABLE ${tables.nodes} DROP CONSTRAINT nodes_pkey`);
  const columns = (await tx.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema=$1 AND data_type='text'
       AND (column_name=ANY($2::text[]) OR column_name LIKE '%\\_id' ESCAPE '\\')
       AND collation_name IS DISTINCT FROM 'C'
     ORDER BY table_name,ordinal_position`,
    [schema, [...STORAGE_IDENTITY_COLUMNS]],
  )).rows;
  const managed = new Set([
    ...Object.keys(tables),
    "copilotz_operations",
    "copilotz_operation_events",
    "copilotz_operation_streams",
    "copilotz_operation_selection_heads",
    "copilotz_operation_selections",
    "copilotz_vectors",
    "content_bodies",
    "content_body_parts",
  ]);
  const alterations = new Map<string, string[]>();
  for (const column of columns) {
    if (!managed.has(column.table_name)) continue;
    const clauses = alterations.get(column.table_name) ?? [];
    clauses.push(
      `ALTER COLUMN ${
        quoteEventIdentifier(column.column_name)
      } TYPE TEXT COLLATE "C"`,
    );
    alterations.set(column.table_name, clauses);
  }
  // PostgreSQL rebuilds affected indexes once per table, not once per column.
  let done = 0;
  for (const [table, clauses] of alterations) {
    await tx.query(`ALTER TABLE ${qualified(table)} ${clauses.join(",")}`);
    console.error(
      `[upgrade:${schema}] storage tables ${++done}/${alterations.size}`,
    );
  }
  // JSON expressions do not inherit the collation changes on identity columns.
  // Rebuild this reference index so body_id joins use an Index Cond, not a filter.
  await tx.query(
    `DROP INDEX IF EXISTS "${schema}".nodes_ready_content_body_idx`,
  );
  await tx.query(readyContentBodyIndexStatement(schema));
  await tx.query(`ALTER TABLE ${tables.nodes} ADD PRIMARY KEY (namespace,id)`);
  for (const key of foreignKeys) {
    const definition = key.node_column
      ? `FOREIGN KEY (namespace,${
        quoteEventIdentifier(key.node_column)
      }) REFERENCES ${tables.nodes}(namespace,id) ON DELETE CASCADE`
      : key.definition;
    await tx.query(
      `ALTER TABLE ${qualified(key.table_name)} ADD CONSTRAINT ${
        quoteEventIdentifier(key.name)
      } ${definition}`,
    );
  }
}
