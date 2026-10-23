/** Compare untouched old and new code on one synthetic database, using savepoints. */
import { assertEquals } from "@std/assert";
import { resolve, toFileUrl } from "@std/path";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import type { SqlExecutor, SqlSession } from "../runtime/events/session.ts";
import { scaleRetainedFixture } from "./fixtures/retained-upgrade/scale.ts";
import {
  prepareRetainedDataUpgrade,
  upgradeActionLifecycle,
} from "../runtime/actions/upgrade.ts";
import { ensureOwnerDataKey } from "../runtime/actions/owner-data-key.ts";
import { createOwnerDataKeyStatements } from "../runtime/events/schema.ts";
import { migrateOwnerKeys } from "../runtime/actions/migrate-owner-keys.ts";
import { upgradeAuthoritySchema } from "../runtime/authorization/upgrade.ts";
import { upgradeCredentialEffects } from "../runtime/authorization/credentials-upgrade.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";

const [
  beforePath,
  urlString = "postgres://postgres@localhost:55439/cutover_equivalence",
  eventCount = "1000",
] = Deno.args;
if (!beforePath) {
  throw new Error(
    "Supply a filesystem copy of the old source; this script never invokes git.",
  );
}
const url = new URL(urlString);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.port !== "55439" || !/^\/cutover_[a-z0-9_]+$/.test(url.pathname)
) throw new Error("A local cutover_* database on port 55439 is required.");
const root = toFileUrl(resolve(beforePath) + "/");
const oldUpgrade = await import(
  new URL("runtime/actions/upgrade.ts", root).href
);
const oldAuthority = await import(
  new URL("runtime/authorization/upgrade.ts", root).href
);
const oldKeys = await import(
  new URL("runtime/actions/migrate-owner-keys.ts", root).href
);
const oldStorage = await import(
  new URL("runtime/authorization/credentials-upgrade.ts", root).href
);
const managed = await openManagedOminipgDatabase({
  url: url.href,
  statementTimeoutMs: null,
  requestTimeoutMs: 86400000,
  pgPoolMax: 1,
});
const db = managed.session, schema = "equivalence";

// Generated edge IDs are intentionally random in both implementations. Supply
// the same deterministic test identity at the SQL seam; every persisted field
// can then be compared exactly. Both runs share one transaction timestamp.
function comparable(tx: SqlExecutor): SqlSession {
  const query: SqlExecutor["query"] = async (sql, params) => {
    if (
      sql.includes('UPDATE "equivalence"."content_bodies"') &&
      sql.includes("reservation_id=")
    ) {
      if (sql.includes("jsonb_to_recordset")) {
        const rows = JSON.parse(String(params![0]));
        for (const row of rows) {
          row.reservation = `migrated:${row.id}`;
          row.version = `version:${row.id}`;
        }
        params = [JSON.stringify(rows)];
      } else {params = [
          params![0],
          `migrated:${params![0]}`,
          `version:${params![0]}`,
        ];}
    }
    if (sql.includes("SET version=0,upgrade_from=$1")) {
      params = [params![0], params![1], "equivalence-upgrade"];
    }
    if (sql.includes('INSERT INTO "equivalence"."edges"')) {
      if (sql.includes("jsonb_to_recordset")) {
        const rows = JSON.parse(String(params![0]));
        for (const row of rows) {
          row.id = JSON.stringify([
            "equivalence",
            row.namespace,
            row.owner,
            row.asset,
          ]);
        }
        params = [JSON.stringify(rows)];
      } else {
        params = [
          JSON.stringify(["equivalence", params![1], params![2], params![3]]),
          ...params!.slice(1),
        ];
      }
    }
    return await tx.query(sql, params);
  };
  return { query, transaction: (run) => run({ query }) };
}
async function snapshot(tx: SqlExecutor) {
  const names = (await tx.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
    [schema],
  )).rows;
  const tables: Record<string, unknown> = {};
  for (const { table_name } of names) {
    const name = '"' + table_name.replaceAll('"', '""') + '"';
    tables[table_name] = (await tx.query(
      `SELECT count(*) AS rows,encode(sha256(convert_to(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''),'UTF8')),'hex') AS digest FROM "${schema}".${name} t`,
    )).rows[0];
  }
  const columns = (await tx.query(
    "SELECT table_name,column_name,data_type,is_nullable,column_default,collation_name FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position",
    [schema],
  )).rows;
  const constraints = (await tx.query(
    "SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,k.conname",
    [schema],
  )).rows;
  const indexes = (await tx.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY indexname",
    [schema],
  )).rows;
  return { tables, columns, constraints, indexes };
}
async function compare(
  name: string,
  old: (session: SqlSession) => Promise<unknown>,
  current: (session: SqlSession) => Promise<unknown>,
) {
  await db.transaction(async (tx) => {
    const session = comparable(tx);
    await tx.query("SAVEPOINT comparison");
    const beforeResult = await old(session);
    const before = await snapshot(tx);
    await tx.query("ROLLBACK TO SAVEPOINT comparison");
    const afterResult = await current(session);
    const after = await snapshot(tx);
    assertEquals(afterResult, beforeResult, `${name} return value`);
    assertEquals(after, before, `${name} exhaustive data and DDL digest`);
    console.log(JSON.stringify({ step: name, equal: true, ...after }));
  });
}
try {
  await scaleRetainedFixture(db, schema, {
    events: Number(eventCount),
    bodyBytes: 1024,
  });
  await compare(
    "prepare-v7-to-marker0",
    (session) => oldUpgrade.prepareRetainedDataUpgrade(session, schema),
    (session) => prepareRetainedDataUpgrade(session, schema),
  );
  const plan = await prepareRetainedDataUpgrade(db, schema);
  if (!plan) throw new Error("Missing synthetic plan.");
  await compare(
    "prepared-plan-and-fingerprint",
    (session) => oldUpgrade.prepareRetainedDataUpgrade(session, schema),
    (session) => prepareRetainedDataUpgrade(session, schema),
  );
  const finish = async (
    fn: typeof upgradeActionLifecycle,
    session: SqlSession,
  ) => {
    try {
      await fn(session, schema, {
        plan,
        reviewedFingerprint: plan.fingerprint,
      });
    } catch (error) {
      if (
        (error as { code?: string }).code !==
          "copilotz_upgrade_owner_keys_required"
      ) throw error;
    }
  };
  await compare(
    "finalize-v11",
    (session) => finish(oldUpgrade.upgradeActionLifecycle, session),
    (session) => finish(upgradeActionLifecycle, session),
  );
  const adapter = await testSecretAdapter();
  // Share the same already wrapped test key, isolating conversion from random
  // key generation while retaining real adapter unwrap and digest verification.
  for (const sql of createOwnerDataKeyStatements(schema)) await db.query(sql);
  await ensureOwnerDataKey(db, schema, adapter);
  await compare(
    "owner-keys-v12",
    (session) =>
      oldKeys.migrateOwnerKeys({
        session,
        schema,
        sourceAdapter: adapter,
        masterAdapter: adapter,
      }),
    (session) =>
      migrateOwnerKeys({
        session,
        schema,
        sourceAdapter: adapter,
        masterAdapter: adapter,
      }),
  );
  await compare(
    "authority-inventory",
    (session) => oldAuthority.inspectAuthorityUpgrade(session, schema),
    async (session) =>
      (await import("../runtime/authorization/upgrade.ts"))
        .inspectAuthorityUpgrade(session, schema),
  );
  const manifest = await testAuthorityManifest(db, schema);
  await compare(
    "authority-v13",
    (session) => oldAuthority.upgradeAuthoritySchema(session, schema, manifest),
    (session) => upgradeAuthoritySchema(session, schema, manifest),
  );
  await compare(
    "storage-v14",
    (session) => oldStorage.upgradeCredentialEffects(session, schema),
    (session) => upgradeCredentialEffects(session, schema),
  );
} finally {
  await managed.close();
}
