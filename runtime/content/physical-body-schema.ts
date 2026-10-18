/** Private physical format. Provisioning never upgrades or repairs retained tables. */
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { OWNER_PHYSICAL_BODY_FORMAT } from "./physical-body-store.ts";

const tableNames = ["content_bodies", "content_body_parts"] as const;
const columns = {
  content_bodies: {
    body_id: "text",
    format: "text",
    state: "text",
    media_type: "text",
    reservation_id: "text",
    writer_generation: "bigint",
    byte_length: "bigint",
    version_token: "text",
  },
  content_body_parts: {
    body_id: "text",
    start_offset: "bigint",
    append_id: "text",
    bytes: "bytea",
  },
} as const;

function incompatible(): never {
  throw Object.assign(
    new Error("Content storage requires an exact private physical schema."),
    {
      code: "owner_physical_schema_incompatible",
    },
  );
}

export function physicalBodyTables(schema: string) {
  const prefix = quoteEventIdentifier(validateEventSchemaName(schema));
  return {
    bodies: `${prefix}."content_bodies"`,
    parts: `${prefix}."content_body_parts"`,
  } as const;
}

/** Legacy callers must refuse before recovery, provisioning or body mutation. */
export async function refuseOwnerPhysicalSchema(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  validateEventSchemaName(schema);
  const result = await executor.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='content_bodies' AND column_name='format' LIMIT 1`,
    [schema],
  );
  if (result.rows.length) incompatible();
}

/** Read-only exact validation; reopening grants no owner catalog authority. */
export async function validatePhysicalBodySchema(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  validateEventSchemaName(schema);
  const relations = await executor.query<
    { name: string; kind: string; persistence: string; inherited: boolean }
  >(
    `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
       (c.relispartition OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
         WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)) AS inherited
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
    [schema, [...tableNames]],
  );
  if (
    relations.rows.length !== 2 ||
    relations.rows.some((row) =>
      row.kind !== "r" || row.persistence !== "p" || row.inherited
    )
  ) incompatible();
  const rows = await executor.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
    is_generated: string;
    domain_name: string | null;
    domain_schema: string | null;
  }>(
    `SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,is_generated,domain_name,domain_schema
      FROM information_schema.columns WHERE table_schema=$1
      AND table_name IN ('content_bodies','content_body_parts')`,
    [schema],
  );
  if (rows.rows.length !== 12) incompatible();
  for (const [table, expected] of Object.entries(columns)) {
    for (const [name, type] of Object.entries(expected)) {
      if (
        !rows.rows.some((row) =>
          row.table_name === table && row.column_name === name &&
          row.data_type === type && row.is_nullable === "NO" &&
          row.column_default === null && row.is_identity === "NO" &&
          row.is_generated === "NEVER" && row.domain_name === null &&
          row.domain_schema === null
        )
      ) incompatible();
    }
  }
  const checks = await executor.query<{
    table_name: string;
    name: string;
    expression: string;
    validated: boolean;
  }>(
    `SELECT t.relname AS table_name,c.conname AS name,
      pg_catalog.pg_get_expr(c.conbin,c.conrelid) AS expression,c.convalidated AS validated
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname IN ('content_bodies','content_body_parts') AND c.contype='c'`,
    [schema],
  );
  const expectedChecks = {
    physical_format: "(format = 'owner-physical-v1'::text)",
    physical_state: "(state = ANY (ARRAY['open'::text, 'fenced'::text]))",
    physical_generation:
      "((writer_generation >= 1) AND (writer_generation <= '9007199254740990'::bigint))",
    physical_length:
      "((byte_length >= 0) AND (byte_length <= '9007199254740991'::bigint))",
    physical_offset:
      "((start_offset >= 0) AND (start_offset <= '9007199254740991'::bigint))",
    physical_part_length:
      "((octet_length(bytes) >= 1) AND (octet_length(bytes) <= 1048576))",
  };
  for (const [name, expression] of Object.entries(expectedChecks)) {
    const table = name === "physical_offset" || name === "physical_part_length"
      ? "content_body_parts"
      : "content_bodies";
    if (
      !checks.rows.some((row) =>
        row.table_name === table && row.name === name && row.validated &&
        row.expression.replace(/\s+/g, " ").trim() === expression
      )
    ) incompatible();
  }
  const keys = await executor.query<{
    table_name: string;
    kind: string;
    columns: string[];
    validated: boolean;
    deferred: boolean;
    target: string | null;
    target_schema: string | null;
    target_columns: string[];
    delete_action: string;
  }>(
    `SELECT t.relname AS table_name,c.contype AS kind,c.convalidated AS validated,
      c.condeferrable AS deferred,c.confdeltype AS delete_action,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      target.relname AS target,tn.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
      LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=target.relnamespace
      WHERE n.nspname=$1 AND t.relname IN ('content_bodies','content_body_parts') AND c.contype IN ('p','u','f')`,
    [schema],
  );
  const same = (a: string[], b: string[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  const has = (table: string, kind: string, fields: string[]) =>
    keys.rows.some((row) =>
      row.table_name === table && row.kind === kind && row.validated &&
      !row.deferred && same(row.columns, fields)
    );
  if (
    !has("content_bodies", "p", ["body_id"]) ||
    !has("content_body_parts", "p", ["body_id", "start_offset"]) ||
    !has("content_body_parts", "u", ["body_id", "append_id"]) ||
    !keys.rows.some((row) =>
      row.table_name === "content_body_parts" && row.kind === "f" &&
      row.validated && !row.deferred && row.target === "content_bodies" &&
      row.target_schema === schema &&
      same(row.columns, ["body_id"]) && same(row.target_columns, ["body_id"]) &&
      row.delete_action === "a"
    )
  ) incompatible();
}

/** Physical-only prerequisite. No catalog rows, admission, migration or repair.
 * writer_generation retains the original reservation generation in both states;
 * returned private heads add one when fenced.
 */
export async function provisionPhysicalBodySchema(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const { bodies, parts } = physicalBodyTables(schema);
  await session.transaction(async (tx) => {
    // Share the core provisioner's lock before inspecting an empty schema.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      schema,
      "copilotz-schema-provision",
    ]);
    const present = await tx.query<{ name: string; kind: string }>(
      `SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
      [schema, [...tableNames]],
    );
    if (present.rows.length) {
      if (
        present.rows.length !== 2 ||
        present.rows.some((row) => row.kind !== "r")
      ) incompatible();
      await validatePhysicalBodySchema(tx, schema);
      return;
    }
    const occupied = await tx.query(
      `SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 LIMIT 1`,
      [schema],
    );
    if (occupied.rows.length) incompatible();
    await tx.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteEventIdentifier(schema)}`,
    );
    await tx.query(`CREATE TABLE ${bodies} (
      body_id TEXT PRIMARY KEY, format TEXT NOT NULL CONSTRAINT physical_format CHECK (format='${OWNER_PHYSICAL_BODY_FORMAT}'),
      state TEXT NOT NULL CONSTRAINT physical_state CHECK (state IN ('open','fenced')),
      media_type TEXT NOT NULL, reservation_id TEXT NOT NULL,
      writer_generation BIGINT NOT NULL CONSTRAINT physical_generation CHECK (writer_generation>=1 AND writer_generation<=9007199254740990),
      byte_length BIGINT NOT NULL CONSTRAINT physical_length CHECK (byte_length>=0 AND byte_length<=9007199254740991),
      version_token TEXT NOT NULL
    )`);
    await tx.query(`CREATE TABLE ${parts} (
      body_id TEXT NOT NULL REFERENCES ${bodies}(body_id),
      start_offset BIGINT NOT NULL CONSTRAINT physical_offset CHECK (start_offset>=0 AND start_offset<=9007199254740991),
      append_id TEXT NOT NULL,
      bytes BYTEA NOT NULL CONSTRAINT physical_part_length CHECK (octet_length(bytes)>=1 AND octet_length(bytes)<=1048576),
      PRIMARY KEY (body_id,start_offset), UNIQUE (body_id,append_id)
    )`);
    await validatePhysicalBodySchema(tx, schema);
  });
}
