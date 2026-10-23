/** The sole database byte layout. Provisioning is atomic and never repairs partial tables. */
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { digestContent } from "./digest.ts";
import { bytesToBase64 } from "./encoding.ts";
import { sha256 } from "@noble/hashes/sha256";
import { BODY_APPEND_MAX_BYTES } from "./body-store-operations.ts";

export function bodyStoreTables(schema: string) {
  const prefix = quoteEventIdentifier(validateEventSchemaName(schema));
  return {
    bodies: `${prefix}."content_bodies"`,
    parts: `${prefix}."content_body_parts"`,
  };
}
const columns = {
  content_bodies: {
    body_id: "text",
    state: "text",
    media_type: "text",
    reservation_id: "text",
    writer_generation: "bigint",
    fenced_from: "bigint",
    byte_length: "bigint",
    digest: "text",
    version_token: "text",
    maintenance_version: "bigint",
    updated_at: "timestamp with time zone",
  },
  content_body_parts: {
    body_id: "text",
    start_offset: "bigint",
    append_id: "text",
    bytes: "bytea",
    part_digest: "text",
  },
} as const;
function incompatible(): never {
  throw Object.assign(
    new Error(
      "Content byte storage schema is missing or incomplete; run its offline migration before activation.",
    ),
    { code: "content_body_schema_incompatible" },
  );
}
async function presence(executor: SqlExecutor, schema: string) {
  return await executor.query<
    { name: string; kind: string; persistence: string; inherited: boolean }
  >(
    `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    (c.relispartition OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)) AS inherited
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
    [schema, Object.keys(columns)],
  );
}
export async function validateBodyStoreSchema(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  validateEventSchemaName(schema);
  const tables = await presence(executor, schema);
  if (
    tables.rows.length !== 2 ||
    tables.rows.some((row) =>
      row.kind !== "r" || row.persistence !== "p" || row.inherited
    )
  ) incompatible();
  const result = await executor.query<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      is_identity: string;
      is_generated: string;
      domain_name: string | null;
    }
  >(
    `SELECT table_name,column_name,data_type,is_nullable,is_identity,is_generated,domain_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name=ANY($2::text[])`,
    [schema, Object.keys(columns)],
  );
  if (result.rows.length !== 16) incompatible();
  for (const [table, fields] of Object.entries(columns)) {
    for (const [name, type] of Object.entries(fields)) {
      const nullable = table === "content_bodies" &&
        ["fenced_from", "digest"].includes(name);
      if (
        !result.rows.some((row) =>
          row.table_name === table && row.column_name === name &&
          row.data_type === type &&
          row.is_nullable === (nullable ? "YES" : "NO") &&
          row.is_identity === "NO" && row.is_generated === "NEVER" &&
          row.domain_name === null
        )
      ) {
        incompatible();
      }
    }
  }
  const keys = await executor.query<
    {
      table_name: string;
      kind: string;
      columns: string[];
      validated: boolean;
      deferred: boolean;
      target: string | null;
      target_schema: string | null;
      target_columns: string[];
      delete_action: string;
    }
  >(
    `SELECT t.relname AS table_name,c.contype AS kind,c.convalidated AS validated,c.condeferrable AS deferred,c.confdeltype AS delete_action,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    target.relname AS target,tn.nspname AS target_schema,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_class target ON target.oid=c.confrelid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=target.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND c.contype IN ('p','u','f')`,
    [schema, Object.keys(columns)],
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
      row.target_schema === schema && same(row.columns, ["body_id"]) &&
      same(row.target_columns, ["body_id"]) && row.delete_action === "c"
    )
  ) incompatible();
  const checks = await executor.query<
    { name: string; expression: string; validated: boolean }
  >(
    `SELECT c.conname AS name,pg_catalog.pg_get_expr(c.conbin,c.conrelid) AS expression,c.convalidated AS validated FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND c.contype='c'`,
    [schema, Object.keys(columns)],
  );
  const expectedChecks: Record<string, string> = {
    body_state:
      "(state = ANY (ARRAY['open'::text, 'ready'::text, 'incomplete'::text, 'aborted'::text]))",
    body_generation:
      "((writer_generation >= 1) AND (writer_generation <= '9007199254740991'::bigint))",
    body_fenced:
      "((fenced_from IS NULL) OR ((fenced_from >= 1) AND (fenced_from = (writer_generation - 1))))",
    body_length:
      "((byte_length >= 0) AND (byte_length <= '9007199254740991'::bigint))",
    body_revision: "(maintenance_version >= 1)",
    body_digest:
      "(((state = ANY (ARRAY['ready'::text, 'incomplete'::text])) AND (digest IS NOT NULL) AND (digest ~ '^sha256:[0-9a-f]{64}$'::text)) OR ((state = ANY (ARRAY['open'::text, 'aborted'::text])) AND (digest IS NULL)))",
    body_offset:
      "((start_offset >= 0) AND (start_offset <= '9007199254740991'::bigint))",
    body_part_length:
      "((octet_length(bytes) >= 1) AND (octet_length(bytes) <= 1048576))",
    body_part_digest: "(part_digest ~ '^sha256:[0-9a-f]{64}$'::text)",
  };
  for (const [name, expression] of Object.entries(expectedChecks)) {
    if (
      !checks.rows.some((row) =>
        row.name === name && row.validated &&
        row.expression.replace(/\s+/g, " ").trim() === expression
      )
    ) incompatible();
  }
}
export async function provisionBodyStoreSchema(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  const { bodies, parts } = bodyStoreTables(schema);
  const existing = await presence(executor, schema);
  if (existing.rows.length) {
    await validateBodyStoreSchema(executor, schema);
    return;
  }
  await executor.query(
    `CREATE SCHEMA IF NOT EXISTS ${quoteEventIdentifier(schema)}`,
  );
  await executor.query(`CREATE TABLE ${bodies} (
    body_id TEXT COLLATE "C" PRIMARY KEY, state TEXT NOT NULL CONSTRAINT body_state CHECK(state IN ('open','ready','incomplete','aborted')),
    media_type TEXT NOT NULL, reservation_id TEXT COLLATE "C" NOT NULL,
    writer_generation BIGINT NOT NULL CONSTRAINT body_generation CHECK(writer_generation>=1 AND writer_generation<=9007199254740991),
    fenced_from BIGINT CONSTRAINT body_fenced CHECK(fenced_from IS NULL OR (fenced_from>=1 AND fenced_from=writer_generation-1)),
    byte_length BIGINT NOT NULL CONSTRAINT body_length CHECK(byte_length>=0 AND byte_length<=9007199254740991),
    digest TEXT CONSTRAINT body_digest CHECK((state IN ('ready','incomplete') AND digest IS NOT NULL AND digest ~ '^sha256:[0-9a-f]{64}$') OR (state IN ('open','aborted') AND digest IS NULL)),
    version_token TEXT COLLATE "C" NOT NULL,maintenance_version BIGINT NOT NULL CONSTRAINT body_revision CHECK(maintenance_version>=1),updated_at TIMESTAMPTZ NOT NULL
  )`);
  await executor.query(`CREATE TABLE ${parts} (
    body_id TEXT COLLATE "C" NOT NULL REFERENCES ${bodies}(body_id) ON DELETE CASCADE,
    start_offset BIGINT NOT NULL CONSTRAINT body_offset CHECK(start_offset>=0 AND start_offset<=9007199254740991),
    append_id TEXT COLLATE "C" NOT NULL,bytes BYTEA NOT NULL CONSTRAINT body_part_length CHECK(octet_length(bytes)>=1 AND octet_length(bytes)<=1048576),
    part_digest TEXT NOT NULL CONSTRAINT body_part_digest CHECK(part_digest ~ '^sha256:[0-9a-f]{64}$'),
    PRIMARY KEY(body_id,start_offset),UNIQUE(body_id,append_id)
  )`);
  await validateBodyStoreSchema(executor, schema);
}
/** Offline, drained-data migration only. Never called by the adapter or provisioning. */
export async function migrateBodyStoreSchema(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const { bodies, parts } = bodyStoreTables(schema);
  await session.transaction(async (transaction) => {
    const existing = await presence(transaction, schema);
    if (!existing.rows.length) {
      await provisionBodyStoreSchema(transaction, schema);
      return;
    }
    if (
      existing.rows.length !== 2 ||
      existing.rows.some((row) => row.kind !== "r")
    ) incompatible();
    const marker = await transaction.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='content_bodies' AND column_name='version_token'`,
      [schema],
    );
    if (marker.rows.length) {
      await validateBodyStoreSchema(transaction, schema);
      return;
    }
    await transaction.query(
      `LOCK TABLE ${bodies},${parts} IN ACCESS EXCLUSIVE MODE`,
    );
    const open = await transaction.query(
      `SELECT 1 FROM ${bodies} WHERE state NOT IN ('ready','incomplete','aborted') LIMIT 1`,
    );
    if (open.rows.length) {
      throw new Error("Drain physical writers before migrating byte storage.");
    }
    const checks = await transaction.query<
      { table_name: string; name: string }
    >(
      `SELECT t.relname AS table_name,c.conname AS name FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND c.contype='c'`,
      [schema, Object.keys(columns)],
    );
    for (const check of checks.rows) {
      await transaction.query(
        `ALTER TABLE ${
          check.table_name === "content_bodies" ? bodies : parts
        } DROP CONSTRAINT ${quoteEventIdentifier(check.name)}`,
      );
    }
    await transaction.query(
      `ALTER TABLE ${bodies} ADD COLUMN reservation_id TEXT COLLATE "C",ADD COLUMN fenced_from BIGINT,ADD COLUMN version_token TEXT COLLATE "C"`,
    );
    const rows = await transaction.query<
      {
        body_id: string;
        state: string;
        byte_length: string | number;
        digest: string | null;
      }
    >(
      `SELECT body_id,state,byte_length,digest FROM ${bodies}`,
    );
    for (let start = 0; start < rows.rows.length; start += 2000) {
      const updates = rows.rows.slice(start, start + 2000).map((row) => ({
        id: row.body_id,
        reservation: `migrated:${crypto.randomUUID()}`,
        version: crypto.randomUUID(),
      }));
      await transaction.query(
        `UPDATE ${bodies} b SET reservation_id=v.reservation,writer_generation=COALESCE(b.writer_generation,1),version_token=v.version,maintenance_version=GREATEST(b.maintenance_version,1),digest=CASE WHEN b.state='aborted' THEN NULL ELSE b.digest END
         FROM jsonb_to_recordset($1::jsonb) AS v(id text,reservation text,version text) WHERE b.body_id=v.id`,
        [JSON.stringify(updates)],
      );
    }
    await transaction.query(
      `ALTER TABLE ${bodies} ALTER COLUMN reservation_id SET NOT NULL,ALTER COLUMN version_token SET NOT NULL,ALTER COLUMN writer_generation SET NOT NULL,DROP COLUMN writer_token_hash,DROP COLUMN lease_expires_at,DROP COLUMN protected_until,DROP COLUMN created_at,DROP COLUMN ready_at`,
    );
    await transaction.query(
      `ALTER TABLE ${parts} ADD COLUMN part_digest TEXT,DROP COLUMN created_at`,
    );
    const sizes = new Map(
      (await transaction.query<{ body_id: string; size: string }>(
        `SELECT body_id,sum(octet_length(bytes)) AS size FROM ${parts} GROUP BY body_id`,
      )).rows.map((row) => [row.body_id, Number(row.size)]),
    );
    let done = 0;
    while (done < rows.rows.length) {
      let end = done, bytesInBatch = 0;
      while (end < rows.rows.length && end - done < 2000) {
        const size = sizes.get(rows.rows[end].body_id) ?? 0;
        if (end > done && bytesInBatch + size > 16 * 1024 * 1024) break;
        bytesInBatch += size;
        end++;
      }
      const batch = rows.rows.slice(done, end);
      const retained = (await transaction.query<
        { body_id: string; bytes: Uint8Array; start_offset: string | number }
      >(
        `SELECT body_id,bytes,start_offset FROM ${parts} WHERE body_id=ANY($1::text[]) ORDER BY body_id,start_offset`,
        [batch.map((body) => body.body_id)],
      )).rows;
      const byBody = new Map<string, typeof retained>();
      for (const part of retained) {
        const list = byBody.get(part.body_id) ?? [];
        list.push(part);
        byBody.set(part.body_id, list);
      }
      for (const body of batch) {
        if (body.state === "aborted") continue;
        const length = Number(body.byte_length), hash = sha256.create();
        let covered = 0;
        for (const part of byBody.get(body.body_id) ?? []) {
          if (Number(part.start_offset) !== covered) incompatible();
          hash.update(part.bytes.subarray(0, Math.max(0, length - covered)));
          covered += part.bytes.length;
        }
        const digest = `sha256:${
          Array.from(
            hash.digest(),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("")
        }`;
        if (
          !Number.isSafeInteger(length) || length < 0 || covered < length ||
          (body.state === "ready" && covered !== length) ||
          digest !== body.digest
        ) {
          throw new Error(
            "Retained physical body bytes do not match their terminal metadata.",
          );
        }
      }
      await transaction.query(
        `DELETE FROM ${parts} WHERE body_id=ANY($1::text[])`,
        [batch.map((body) => body.body_id)],
      );
      const chunks: Record<string, unknown>[] = [];
      let chunkBytes = 0;
      const flush = async () => {
        if (!chunks.length) return;
        await transaction.query(
          `INSERT INTO ${parts}(body_id,start_offset,append_id,bytes,part_digest)
           SELECT body_id,start_offset,append_id,decode(bytes,'base64'),part_digest
           FROM jsonb_to_recordset($1::jsonb) AS v(body_id text,start_offset bigint,append_id text,bytes text,part_digest text)`,
          [JSON.stringify(chunks)],
        );
        chunks.length = 0;
        chunkBytes = 0;
      };
      for (const row of retained) {
        for (
          let start = 0;
          start < row.bytes.length;
          start += BODY_APPEND_MAX_BYTES
        ) {
          const bytes = row.bytes.subarray(
              start,
              start + BODY_APPEND_MAX_BYTES,
            ),
            offset = Number(row.start_offset) + start;
          chunks.push({
            body_id: row.body_id,
            start_offset: offset,
            append_id: `migrated:${offset}`,
            bytes: bytesToBase64(bytes),
            part_digest: await digestContent(bytes),
          });
          chunkBytes += bytes.length;
          if (chunks.length === 2000 || chunkBytes >= 16 * 1024 * 1024) {
            await flush();
          }
        }
      }
      await flush();
      done = end;
      console.error(
        `[upgrade:${schema}] physical bodies ${done}/${rows.rows.length}`,
      );
    }
    await transaction.query(
      `ALTER TABLE ${parts} ALTER COLUMN part_digest SET NOT NULL`,
    );
    await transaction.query(`ALTER TABLE ${bodies}
      ADD CONSTRAINT body_state CHECK(state IN ('open','ready','incomplete','aborted')),
      ADD CONSTRAINT body_generation CHECK(writer_generation>=1 AND writer_generation<=9007199254740991),
      ADD CONSTRAINT body_fenced CHECK(fenced_from IS NULL OR (fenced_from>=1 AND fenced_from=writer_generation-1)),
      ADD CONSTRAINT body_length CHECK(byte_length>=0 AND byte_length<=9007199254740991),
      ADD CONSTRAINT body_revision CHECK(maintenance_version>=1),
      ADD CONSTRAINT body_digest CHECK((state IN ('ready','incomplete') AND digest IS NOT NULL AND digest ~ '^sha256:[0-9a-f]{64}$') OR (state IN ('open','aborted') AND digest IS NULL))`);
    await transaction.query(`ALTER TABLE ${parts}
      ADD CONSTRAINT body_offset CHECK(start_offset>=0 AND start_offset<=9007199254740991),
      ADD CONSTRAINT body_part_length CHECK(octet_length(bytes)>=1 AND octet_length(bytes)<=1048576),
      ADD CONSTRAINT body_part_digest CHECK(part_digest ~ '^sha256:[0-9a-f]{64}$')`);
    await validateBodyStoreSchema(transaction, schema);
  });
}
