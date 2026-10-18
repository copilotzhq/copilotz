/** Private owner catalog format. Fresh provisioning and validation-only reopen; no retained-schema repair. */
import { OWNER_CONTENT_CATALOG_FINGERPRINT } from "../events/catalog-format.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createOperationCatalogTables,
  type OperationCatalogTables,
} from "./catalog.ts";
import { operationCatalogSchemaStatements } from "./catalog-schema.ts";
import { OWNER_CATALOG_LAYOUT } from "./owner-catalog-layout.ts";

const tableNames = [
  "copilotz_operation_catalog_metadata",
  "copilotz_operations",
  "copilotz_operation_events",
  "copilotz_operation_streams",
  "copilotz_operation_selection_heads",
  "copilotz_operation_selections",
];
const sequenceName = "copilotz_operation_streams_replay_key_seq";
function incompatible(): never {
  throw Object.assign(
    new Error("Owner content catalog requires its exact fresh schema format."),
    {
      code: "owner_content_catalog_schema_incompatible",
    },
  );
}

// Format-specific retained-layout proof. The expected inventory is checked in
// alongside the closed DDL, not learned from the database being reopened.
async function readLayout(executor: SqlExecutor, schema: string) {
  const owned = await executor.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
    AND (c.relname LIKE 'copilotz_operation%' OR c.relname='owner_stream_physical_key') ORDER BY c.relname`,
    [schema],
  );
  const expectedNames = [
    ...tableNames,
    sequenceName,
    ...Object.values(OWNER_CATALOG_LAYOUT.indexes).flatMap((indexes) =>
      Object.keys(indexes)
    ),
  ].sort();
  if (
    JSON.stringify(owned.rows.map((r) => r.name)) !==
      JSON.stringify(expectedNames)
  ) incompatible();
  const params = [schema, tableNames];
  const relations = await executor.query(
    `SELECT c.relname AS name,c.relkind::text AS kind,
    c.relpersistence::text AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced_rls,
    (c.relispartition OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
      WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)) AS inherited,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS user_triggers,
    EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid) AS rules
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
    params,
  );
  const columns = await executor.query(
    `SELECT table_name,column_name,data_type,is_nullable,
    CASE WHEN table_name='copilotz_operation_streams' AND column_name='replay_key'
      AND column_default = format('nextval(%L::regclass)',to_regclass(format('%I.%I',$1::text,'copilotz_operation_streams_replay_key_seq'))::text)
      THEN '<owned replay sequence>' ELSE column_default END AS column_default,
    is_identity,is_generated,domain_schema,domain_name,collation_schema,collation_name,udt_schema,udt_name,datetime_precision
    FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])
    ORDER BY table_name,ordinal_position`,
    params,
  );
  const constraints = await executor.query(
    `SELECT t.relname AS table_name,c.conname AS name,
    c.contype::text AS kind,c.convalidated AS validated,c.condeferrable AS deferrable,
    c.condeferred AS deferred,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY t.relname,c.conname`,
    params,
  );
  const indexes = await executor.query(
    `SELECT t.relname AS table_name,c.relname AS name,
    am.amname AS method,i.indisunique AS unique,i.indisprimary AS primary,
    i.indisvalid AS valid,i.indisready AS ready,i.indimmediate AS immediate,
    i.indisexclusion AS exclusion,i.indnullsnotdistinct AS nulls_not_distinct,i.indnkeyatts AS key_count,i.indnatts AS total_count,
    ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid,k,true)
      FROM generate_series(1,i.indnatts) k ORDER BY k) AS keys,
    ARRAY(SELECT ns.nspname || '.' || op.opcname
      FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(oid,ord)
      JOIN pg_catalog.pg_opclass op ON op.oid=k.oid
      JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace ORDER BY k.ord) AS operator_classes,
    ARRAY(SELECT CASE WHEN k.oid=0 THEN NULL ELSE ns.nspname || '.' || co.collname END
      FROM unnest(i.indcollation::oid[]) WITH ORDINALITY k(oid,ord)
      LEFT JOIN pg_catalog.pg_collation co ON co.oid=k.oid
      LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid=co.collnamespace ORDER BY k.ord) AS collations,
    i.indoption::text AS options,pg_catalog.pg_get_expr(i.indpred,i.indrelid,true) AS predicate
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY t.relname,c.relname`,
    params,
  );
  const sequences = await executor.query(
    `SELECT c.relname AS name,c.relkind::text AS kind,
    c.relpersistence::text AS persistence,format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmax::text AS max,
    s.seqmin::text AS min,s.seqcache::text AS cache,s.seqcycle AS cycle,
    t.relname AS owner_table,a.attname AS owner_column,d.deptype::text AS dependency,
    (tn.nspname=$1) AS same_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE n.nspname=$1 AND c.relname=$2 ORDER BY c.relname`,
    [schema, sequenceName],
  );
  if (
    relations.rows.some((r) =>
      r.kind !== "r" || r.persistence !== "p" || r.rls !== false ||
      r.forced_rls !== false || r.inherited !== false ||
      r.user_triggers !== false || r.rules !== false
    ) ||
    columns.rows.some((r) =>
      r.is_identity !== "NO" || r.is_generated !== "NEVER" ||
      r.domain_schema !== null || r.domain_name !== null ||
      r.udt_schema !== "pg_catalog" ||
      (r.data_type === "timestamp with time zone" &&
        r.datetime_precision !== 6) ||
      (r.data_type === "ARRAY" && r.udt_name !== "_text") ||
      r.collation_schema !== null || r.collation_name !== null
    ) ||
    constraints.rows.some((r) =>
      r.validated !== true || r.deferrable !== false || r.deferred !== false
    ) ||
    indexes.rows.some((r) =>
      r.valid !== true || r.ready !== true || r.immediate !== true ||
      r.exclusion !== false || r.nulls_not_distinct !== false ||
      r.key_count !== r.total_count
    )
  ) incompatible();
  // SQL identifiers are untrusted data, including names such as __proto__.
  const columnLayout: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  for (const r of columns.rows) {
    (columnLayout[String(r.table_name)] ??= Object.create(null))[
      String(r.column_name)
    ] = [
      r.data_type,
      r.is_nullable,
      r.column_default,
    ];
  }
  const constraintLayout: Record<string, Record<string, unknown>> = Object
    .create(null);
  for (const r of constraints.rows) {
    (constraintLayout[String(r.table_name)] ??= Object.create(null))[
      String(r.name)
    ] = [
      r.kind,
      r.definition,
    ];
  }
  const indexLayout: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  for (const r of indexes.rows) {
    (indexLayout[String(r.table_name)] ??= Object.create(null))[
      String(r.name)
    ] = [
      r.method,
      r.unique,
      r.primary,
      r.keys,
      r.operator_classes,
      r.collations,
      r.options,
      r.predicate,
    ];
  }
  return {
    relations: relations.rows.map((r) => r.name),
    columns: columnLayout,
    constraints: constraintLayout,
    indexes: indexLayout,
    sequences: sequences.rows,
  };
}

async function assertSeparatePhysicalNamespace(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  const physical = await executor.query(
    `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('content_bodies','content_body_parts') LIMIT 1`,
    [schema],
  );
  if (physical.rows.length) incompatible();
}

export async function validateOwnerContentCatalog(
  executor: SqlExecutor,
  databaseSchema: string,
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = createOperationCatalogTables(schema);
  await assertSeparatePhysicalNamespace(executor, schema);
  const layout = await readLayout(executor, schema);
  if (JSON.stringify(layout) !== JSON.stringify(OWNER_CATALOG_LAYOUT)) {
    incompatible();
  }
  const marker = await executor.query<
    { singleton: boolean; fingerprint: string }
  >(`SELECT singleton,fingerprint FROM ${tables.metadata}`);
  if (
    marker.rows.length !== 1 || marker.rows[0].singleton !== true ||
    marker.rows[0].fingerprint !== OWNER_CONTENT_CATALOG_FINGERPRINT
  ) incompatible();
  return tables;
}

export async function provisionOwnerContentCatalog(
  session: SqlSession,
  databaseSchema: string,
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = createOperationCatalogTables(schema);
  await session.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      schema,
      "copilotz-schema-provision",
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      schema,
      "copilotz-operation-catalog",
    ]);
    await assertSeparatePhysicalNamespace(tx, schema);
    const existing = await tx.query(
      `SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND (c.relname LIKE 'copilotz_operation%' OR c.relname='owner_stream_physical_key')`,
      [schema],
    );
    if (existing.rows.length) {
      await validateOwnerContentCatalog(tx, schema);
      return;
    }
    // No retained owner state is adopted as a fresh catalog, even if its current
    // tables appear empty. Coordinated fresh ordering installs owner tables later.
    const ownerRelations = await tx.query(
      `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('owner_epochs','owner_receipts','owner_receipt_readers','owner_alarms','owner_assignments') LIMIT 1`,
      [schema],
    );
    if (ownerRelations.rows.length) incompatible();
    const core = createCoreTableNames(schema);
    const coreRelations = await tx.query<
      {
        name: string;
        kind: string;
        persistence: string;
        inherited: boolean;
        rls: boolean;
        forced_rls: boolean;
      }
    >(
      `SELECT c.relname AS name,c.relkind::text AS kind,c.relpersistence::text AS persistence,
      c.relrowsecurity AS rls,c.relforcerowsecurity AS forced_rls,
      (c.relispartition OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)) AS inherited
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
      [schema, Object.keys(core)],
    );
    if (coreRelations.rows.length) {
      if (
        coreRelations.rows.length !== Object.keys(core).length ||
        coreRelations.rows.some((r) =>
          r.kind !== "r" || r.persistence !== "p" || r.inherited || r.rls ||
          r.forced_rls
        )
      ) incompatible();
      // Hold the emptiness proof through marker commit against ordinary writers.
      await tx.query(
        `LOCK TABLE ${Object.values(core).join(",")} IN ACCESS EXCLUSIVE MODE`,
      );
      await validateCopilotzSchema(tx, schema);
      const metadata = await tx.query(
        `SELECT singleton FROM ${core.copilotz_schema_metadata}`,
      );
      if (metadata.rows.length !== 1 || metadata.rows[0].singleton !== true) {
        incompatible();
      }
      for (const [name, table] of Object.entries(core)) {
        if (
          name !== "copilotz_schema_metadata" &&
          (await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length
        ) incompatible();
      }
    }
    await tx.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteEventIdentifier(schema)}`,
    );
    for (
      const statement of operationCatalogSchemaStatements(
        tables,
        "owner-content",
      )
    ) await tx.query(statement);
    await tx.query(
      `INSERT INTO ${tables.metadata} (singleton,fingerprint) VALUES (TRUE,$1)`,
      [OWNER_CONTENT_CATALOG_FINGERPRINT],
    );
    await validateOwnerContentCatalog(tx, schema);
  });
  return tables;
}
