/** Synthetic scale regression: sequential phases, bounded disk, unconditional cleanup. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import type { SqlExecutor, SqlSession } from "../runtime/events/session.ts";
import { scaleRetainedFixture } from "./fixtures/retained-upgrade/scale.ts";
import { pruneRetainedHistory } from "./prune-retained-history.ts";
import { inspectRetainedDataDrain } from "../runtime/actions/drain.ts";
import {
  prepareRetainedDataUpgrade,
  upgradeActionLifecycle,
} from "../runtime/actions/upgrade.ts";
import {
  abandonmentDecisions,
  inspectUnterminatedRuns,
} from "../runtime/actions/upgrade-terminals.ts";
import { migrateOwnerKeys } from "../runtime/actions/migrate-owner-keys.ts";
import {
  inspectAuthorityUpgrade,
  upgradeAuthoritySchema,
} from "../runtime/authorization/upgrade.ts";
import { upgradeCredentialEffects } from "../runtime/authorization/credentials-upgrade.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { digestContent } from "../runtime/content/digest.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:";
if (url !== ":memory:") {
  const parsed = new URL(url);
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
      parsed.port === "55439" && /^\/cutover_[a-z0-9_]+$/.test(parsed.pathname),
    "Use local port 55439 and a cutover_* database.",
  );
}
const db = await createTestDatabase({
  url,
  pgPoolMax: 1,
  statementTimeoutMs: 60000,
  requestTimeoutMs: 600000,
});
const schema = `scan_guard_${crypto.randomUUID().replaceAll("-", "")}`,
  q = `"${schema}"`;
const results: { step: string; statements: number; ms: number }[] = [];
async function measure<T>(
  step: string,
  limit: number,
  run: (session: SqlSession) => Promise<T>,
) {
  let statements = 0, extraction = 0, streamUpdates = 0;
  const wrap = (tx: SqlExecutor): SqlExecutor => ({
    async query(sql, params) {
      statements++;
      if (
        step === "finalize-v11" && sql.includes("copilotz_operation_streams") &&
        /^\s*UPDATE/.test(sql)
      ) streamUpdates++;
      if (
        sql.includes("WITH keys AS MATERIALIZED") ||
        sql.includes("WITH invoked AS MATERIALIZED")
      ) extraction++;
      if (
        (step === "terminals" || step === "authority-inventory") &&
        (sql.includes("WITH keys AS MATERIALIZED") ||
          sql.includes("WITH invoked AS MATERIALIZED"))
      ) {
        // Catch a correlated sequential scan even if it hides inside one statement.
        const explained = await tx.query<
          { "QUERY PLAN": { Plan: Record<string, unknown> }[] }
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        const visit = (plan: Record<string, unknown>) => {
          if (
            plan["Node Type"] === "Seq Scan" &&
            [
              "event_bodies",
              "events",
              "nodes",
              "edges",
              "copilotz_operation_events",
            ].includes(String(plan["Relation Name"]))
          ) {
            assert(
              Number(plan["Actual Loops"]) <= 1,
              `${step}: repeated full-table scan ${JSON.stringify(plan)}`,
            );
          }
          for (
            const child of (plan.Plans ?? []) as Record<string, unknown>[]
          ) visit(child);
        };
        visit(explained.rows[0]["QUERY PLAN"][0].Plan);
      }
      if (step === "finalize-v11" && sql.includes("SET next_event_ordinal")) {
        const explained = await tx.query<
          { "QUERY PLAN": { Plan: Record<string, unknown> }[] }
        >(`EXPLAIN (FORMAT JSON) ${sql}`, params);
        const noCorrelatedAggregate = (plan: Record<string, unknown>) => {
          assert(
            plan["Parent Relationship"] !== "SubPlan",
            "Ordinal backfill must group events once, not aggregate per operation",
          );
          for (const child of (plan.Plans ?? []) as Record<string, unknown>[]) {
            noCorrelatedAggregate(child);
          }
        };
        noCorrelatedAggregate(explained.rows[0]["QUERY PLAN"][0].Plan);
      }
      return await tx.query(sql, params);
    },
  });
  const session: SqlSession = {
    query: wrap(db).query,
    transaction: (run) => db.transaction((tx) => run(wrap(tx))),
  };
  const begun = performance.now();
  const result = await run(session);
  const ms = Math.round(performance.now() - begun);
  results.push({ step, statements, ms });
  console.log(JSON.stringify(results.at(-1)));
  assert(
    streamUpdates < 10,
    "Stream conversions must be batched, not updated per stream",
  );
  assert(
    statements <= limit,
    `${step}: ${statements} SQL statements exceeds ${limit}`,
  );
  assert(ms < 300000, `${step}: exceeded five-minute scale budget`);
  if (step === "terminals" || step === "authority-inventory") {
    assertEquals(
      extraction,
      1,
      "extract JSON keys once, regardless of page count",
    );
  }
  return result;
}
try {
  await scaleRetainedFixture(db, schema, { events: 125000, bodyBytes: 16 });
  // Reconstruct the oldest supported catalog backfill with 1,000 operations
  // and 100,000 indexed events, including operations with no indexed members.
  await db.query(
    `INSERT INTO ${q}.copilotz_operations(operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at,completed_at)
    SELECT 'bulk-operation-'||i,'archive','synthetic-event-'||(i*100),'bulk-operation-'||i,'completed',now(),now(),now() FROM generate_series(0,999) i`,
  );
  await db.query(
    `INSERT INTO ${q}.copilotz_operation_events(namespace,operation_id,event_id,event_position,event_ordinal,created_at)
    SELECT 'archive','bulk-operation-'||(substring(id from 17)::integer/100),id,position,(substring(id from 17)::integer%100)+1,created_at
    FROM ${q}.events WHERE id LIKE 'synthetic-event-%' AND substring(id from 17)::integer<100000`,
  );
  await db.query(
    `DROP TABLE ${q}.copilotz_operation_selections,${q}.copilotz_operation_selection_heads`,
  );
  await db.query(
    `ALTER TABLE ${q}.copilotz_operations DROP COLUMN next_event_ordinal,DROP COLUMN observation_keys`,
  );
  await db.query(
    `ALTER TABLE ${q}.copilotz_operation_events DROP COLUMN event_ordinal`,
  );
  await db.query(
    `ALTER TABLE ${q}.copilotz_operation_catalog_metadata DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
  );
  await db.query(
    `UPDATE ${q}.copilotz_operation_catalog_metadata SET fingerprint='retained-terminal-streams'`,
  );
  await db.query(
    `ALTER TABLE ${q}.copilotz_operation_catalog_metadata ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check CHECK(fingerprint='retained-terminal-streams')`,
  );
  await db.query(`INSERT INTO ${q}.copilotz_operation_streams
    SELECT (jsonb_populate_record(NULL::${q}.copilotz_operation_streams,to_jsonb(s) || jsonb_build_object(
      'namespace','archive','operation_id','bulk-operation-'||i,'stream_id','bulk-stream-'||i,
      'semantic_stream_id','bulk-stream-'||i,'replay_key',base.n+i+1,'stream_ordinal',1,
      'body_id','synthetic-physical-'||i,'committed_offset',16,'digest',p.digest,
      'state','terminal','outcome','completed','reason',NULL,'availability','retained','descriptor','{}'::jsonb))).*
    FROM generate_series(0,999) i
    CROSS JOIN (SELECT * FROM ${q}.copilotz_operation_streams LIMIT 1) s
    CROSS JOIN (SELECT max(replay_key) AS n FROM ${q}.copilotz_operation_streams) base
    JOIN ${q}.content_bodies p ON p.body_id='synthetic-physical-'||i`);
  // 1,001 bodies force a second summary page. Digests use canonical sorted JSON.
  await db.query(
    `INSERT INTO ${q}.event_bodies(namespace,event_body_id,schema_version,body,digest)
    SELECT 'archive','orphan-'||i,1,body::jsonb,'sha256:'||encode(sha256(convert_to(body,'UTF8')),'hex')
    FROM (SELECT i,'{"actionId":"synthetic.action","actionRunId":"orphan-'||i||'","input":{},"status":"invoked"}' AS body FROM generate_series(1,1001) i) v`,
  );
  const entries = Array.from(
    { length: 1001 },
    (_, i) => ({
      namespace: "archive",
      runId: `orphan-${i + 1}`,
      actionId: "synthetic.action",
      bodyId: `orphan-${i + 1}`,
    }),
  );
  const abandoned = await abandonmentDecisions(entries);
  for (
    const table of [
      "event_bodies",
      "events",
      "nodes",
      "edges",
      "copilotz_operation_events",
    ]
  ) await db.query(`ANALYZE ${q}."${table}"`);
  assert(
    Number(
      (await db.query<{ count: string }>(
        `SELECT count(*) FROM ${q}.event_bodies`,
      )).rows[0].count,
    ) >= 100000,
  );
  const terminals = await measure(
    "terminals",
    3,
    (s) => inspectUnterminatedRuns(s, schema),
  );
  assertEquals(terminals.length, 1001);
  const listed = await measure(
    "pruner-listing",
    1000,
    (s) =>
      pruneRetainedHistory(s, {
        schema,
        eventTypes: [],
        listUnterminated: true,
        progress: () => {},
      }),
  );
  assertEquals(listed.unterminated?.invocations.length, 1001);
  // Exercise reviewed retirement without removing the runs needed by finalization.
  await db.query(
    `INSERT INTO ${q}.events(id,schema_version,type,namespace,payload,metadata,correlation_id)
    SELECT 'prunable-'||i,7,'synthetic.prunable','synthetic','{}','{}','prunable-'||i FROM generate_series(1,1001) i`,
  );
  await measure(
    "pruner-retirement",
    1500,
    (s) =>
      pruneRetainedHistory(s, {
        schema,
        eventTypes: ["synthetic.prunable"],
        apply: true,
        writersStopped: true,
        progress: () => {},
      }),
  );
  assertEquals(
    (await db.query(
      `SELECT 1 FROM ${q}.events WHERE type='synthetic.prunable'`,
    )).rows.length,
    0,
  );
  await measure(
    "drain",
    20,
    async (s) => assert((await inspectRetainedDataDrain(s, schema)).drained),
  );
  const plan = await measure(
    "prepare",
    2000,
    (s) => prepareRetainedDataUpgrade(s, schema, { abandoned }),
  );
  assert(plan);
  await measure("finalize-v11", 4000, async (s) => {
    await assertRejects(
      () =>
        upgradeActionLifecycle(s, schema, {
          plan,
          reviewedFingerprint: plan.fingerprint,
          abandoned,
        }),
      Error,
      "owner",
    );
    assertEquals(
      Number(
        (await s.query<{ version: number }>(
          `SELECT version FROM ${q}.copilotz_schema_metadata`,
        )).rows[0].version,
      ),
      11,
    );
  });
  assertEquals(
    Number(
      (await db.query<{ count: string }>(
        `SELECT count(*) FROM ${q}.copilotz_operations WHERE operation_id LIKE 'bulk-operation-%' AND next_event_ordinal=101`,
      )).rows[0].count,
    ),
    1000,
  );
  // Drive the non-PK copy updates in v12 with 1,001 in-memory external bodies.
  const digest = await digestContent(new Uint8Array());
  await db.query(
    `INSERT INTO ${q}.content_logical_bodies(body_id,namespace,current_copy,writer_id,generation,revocation,protected_until,committed_offset,terminal)
    SELECT 'external-'||i,'archive','external-copy-'||i,'synthetic',1,'revoked',now(),0,jsonb_build_object('outcome','completed','length',0,'digest',$1::text) FROM generate_series(1,1001) i`,
    [digest],
  );
  await db.query(
    `INSERT INTO ${q}.content_copies(copy_key,backend_kind,backend_id,body_id,state) SELECT 'external-copy-'||i,'object','synthetic','external-'||i,'current' FROM generate_series(1,1001) i`,
  );
  const adapter = await testSecretAdapter();
  await measure("owner-keys-v12", 2500, (s) =>
    migrateOwnerKeys({
      session: s,
      schema,
      sourceAdapter: adapter,
      masterAdapter: adapter,
      readExternalBody: () =>
        Promise.resolve({
          bytes: new Uint8Array(),
          mediaType: "application/octet-stream",
        }),
    }));
  await measure(
    "authority-inventory",
    60,
    (s) => inspectAuthorityUpgrade(s, schema),
  );
  const manifest = await testAuthorityManifest(db, schema);
  await measure(
    "authority-v13",
    300,
    (s) => upgradeAuthoritySchema(s, schema, manifest),
  );
  await measure("storage-v14", 300, (s) => upgradeCredentialEffects(s, schema));
  assertEquals(
    Number(
      (await db.query<{ version: number }>(
        `SELECT version FROM ${q}.copilotz_schema_metadata`,
      )).rows[0].version,
    ),
    14,
  );
  console.log(
    JSON.stringify(
      { bodies: 100000, unterminatedRuns: 1001, externalCopies: 1001, results },
      null,
      2,
    ),
  );
} finally {
  await db.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`);
  await db.close();
}
