/** Sequential, synthetic-only PostgreSQL rehearsal. See benchmark-offline-upgrade.md. */
import { resolve, toFileUrl } from "@std/path";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import { scaleRetainedFixture } from "./fixtures/retained-upgrade/scale.ts";
import type { SqlExecutor, SqlSession } from "../runtime/events/session.ts";
import type { RetainedDataUpgradePlan } from "../runtime/actions/upgrade.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";

const arg = (name: string, fallback: string) =>
  Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  ) ?? fallback;
const url = new URL(
  arg("url", "postgres://postgres@localhost:55439/migperf_small"),
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.port !== "55439" || !/^\/migperf_[a-z0-9_]+$/.test(url.pathname)
) {
  throw new Error(
    "Benchmark requires a local migperf_* database on port 55439.",
  );
}
const source = toFileUrl(resolve(arg("source", ".")) + "/");
const load = (path: string) => import(new URL(path, source).href);
const { prepareRetainedDataUpgrade, upgradeActionLifecycle } = await load(
  "runtime/actions/upgrade.ts",
);
const { inspectRetainedDataDrain } = await load("runtime/actions/drain.ts");
const { inspectAuthorityUpgrade, upgradeAuthoritySchema } = await load(
  "runtime/authorization/upgrade.ts",
);
const { migrateOwnerKeys } = await load(
  "runtime/actions/migrate-owner-keys.ts",
);
const { upgradeCredentialEffects } = await load(
  "runtime/authorization/credentials-upgrade.ts",
);
const managed = await openManagedOminipgDatabase({
  url: url.href,
  statementTimeoutMs: null,
  requestTimeoutMs: 24 * 60 * 60 * 1000,
  pgPoolMax: 1,
});
const db = managed.session;
const report: Record<string, unknown> = {
  source: source.href,
  events: Number(arg("events", "50000")),
  bodyBytes: Number(arg("body-bytes", "1024")),
  schemas: Number(arg("schemas", "3")),
  steps: [],
};
const results = report.steps as Record<string, unknown>[];
let statsAvailable = false;
try {
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  await db.query("SELECT count(*) FROM pg_stat_statements");
  statsAvailable = true;
} catch {
  console.error(
    "pg_stat_statements unavailable; reporting client SQL counts and timings.",
  );
}
report.pgStatStatements = statsAvailable;
const output = arg("output", "/tmp/migperf-report.json");
async function saveReport() {
  await Deno.writeTextFile(
    output + ".tmp",
    JSON.stringify(report, null, 2) + "\n",
  );
  await Deno.rename(output + ".tmp", output);
}
const latency = Number(arg("latency-ms", "0"));
const selected = new Set(arg("steps", "all").split(","));
const enabled = (step: string) => selected.has("all") || selected.has(step);
for (
  const [name, value] of [["events", report.events], [
    "body-bytes",
    report.bodyBytes,
  ], ["schemas", report.schemas]] as const
) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid --${name}.`);
  }
}
if (Number(report.events) % 50 !== 0 || Number(report.bodyBytes) > 1048576) {
  throw new Error(
    "Use an event count divisible by 50 and body sizes up to 1 MiB.",
  );
}
report.latencyMs = latency;
report.checkpoint = arg("checkpoint", "no") === "yes";
report.discardSchemas = arg("discard-schema", "no") === "yes";
report.rollback = arg("rollback", "no") === "yes";
report.stepsSelected = [...selected];
report.server = (await db.query(
  "SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem",
)).rows[0];
async function measure<T>(
  schema: string,
  step: string,
  run: (session: SqlSession) => Promise<T>,
): Promise<T> {
  const queries = new Map<string, { calls: number; ms: number }>();
  let statementCount = 0;
  const begun = performance.now(), startedAt = Date.now();
  report.running = { schema, step, statements: 0, startedAt };
  await saveReport();
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    async query(sql, params) {
      const key = sql.replaceAll(/\s+/g, " ").trim();
      const stat = queries.get(key) ?? { calls: 0, ms: 0 };
      queries.set(key, stat);
      const start = performance.now();
      stat.calls++;
      statementCount++;
      if (statementCount % 2000 === 0) {
        report.running = {
          schema,
          step,
          statements: statementCount,
          startedAt,
          wallMs: performance.now() - begun,
          top: [...queries].map(([sql, stats]) => ({ sql, ...stats })).sort((
            a,
            b,
          ) => b.ms - a.ms).slice(0, 15),
        };
        await saveReport();
      }
      try {
        if (latency) {
          await new Promise((resolve) => setTimeout(resolve, latency));
        }
        return await executor.query(sql, params);
      } finally {
        stat.ms += performance.now() - start;
      }
    },
  });
  const session: SqlSession = {
    query: wrap(db).query,
    transaction: (run) => db.transaction((tx) => run(wrap(tx))),
  };
  if (statsAvailable) {
    await db.query(
      "SELECT pg_stat_statements_reset(0,(SELECT oid FROM pg_database WHERE datname=current_database()),0)",
    );
  }
  const start = performance.now();
  let error: unknown;
  try {
    if (arg("rollback", "no") === "yes") {
      const rollback = Symbol("benchmark rollback");
      let result: T;
      try {
        await db.transaction(async (tx) => {
          const executor = wrap(tx);
          result = await run({
            query: executor.query,
            transaction: (operation) => operation(executor),
          });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return result!;
    }
    return await run(session);
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    const wallMs = performance.now() - start;
    const top = [...queries].map(([sql, stat]) => ({ sql, ...stat })).sort((
      a,
      b,
    ) => b.ms - a.ms);
    const server = statsAvailable
      ? (await db.query(
        `SELECT query,calls,total_exec_time,rows,shared_blks_read,temp_blks_written FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 15`,
      )).rows
      : [];
    const result = {
      schema,
      step,
      wallMs,
      statements: top.reduce((sum, q) => sum + q.calls, 0),
      top: top.slice(0, 15),
      server,
      ...(error ? { error: String(error) } : {}),
    };
    delete report.running;
    results.push(result);
    console.error(
      JSON.stringify({
        schema,
        step,
        seconds: wallMs / 1000,
        statements: result.statements,
        ...(error ? { error: String(error) } : {}),
      }),
    );
    await saveReport();
    if (arg("checkpoint", "no") === "yes") await db.query("CHECKPOINT");
  }
}
try {
  for (let index = 0; index < Number(report.schemas); index++) {
    const schema = arg("schema", `owner_${index + 1}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      throw new Error("Invalid schema.");
    }
    if (enabled("fixture") && arg("restore", "yes") === "yes") {
      await measure(
        schema,
        "fixture",
        (session) =>
          scaleRetainedFixture(session, schema, {
            events: Number(report.events),
            bodyBytes: Number(report.bodyBytes),
            orphan: arg("orphan", "no") === "yes",
          }),
      );
    }
    if (enabled("drain")) {
      await measure(schema, "drain", async (session) => {
        const drain = await inspectRetainedDataDrain(session, schema);
        if (!drain.drained) {
          throw new Error("Synthetic fixture is not drained.");
        }
      });
    }
    const plan = enabled("prepare")
      ? await measure<RetainedDataUpgradePlan | undefined>(
        schema,
        "prepare",
        (session) => prepareRetainedDataUpgrade(session, schema),
      )
      : enabled("finalize-v11")
      ? await (await import("../runtime/actions/upgrade.ts"))
        .prepareRetainedDataUpgrade(db, schema)
      : undefined;
    if (enabled("finalize-v11")) {
      await measure(schema, "finalize-v11", async (session) => {
        if (!plan) {
          throw new Error(
            "Finalization requires a prepared synthetic fixture.",
          );
        }
        try {
          await upgradeActionLifecycle(session, schema, {
            plan,
            reviewedFingerprint: plan.fingerprint,
          });
        } catch (error) {
          if (
            (error as { code?: string }).code !==
              "copilotz_upgrade_owner_keys_required"
          ) {
            throw error;
          }
        }
      });
    }
    const adapter = await testSecretAdapter();
    if (enabled("owner-keys-v12")) {
      await measure(
        schema,
        "owner-keys-v12",
        (session) =>
          migrateOwnerKeys({
            session,
            schema,
            sourceAdapter: adapter,
            masterAdapter: adapter,
          }),
      );
    }
    if (enabled("authority-inventory")) {
      await measure(
        schema,
        "authority-inventory",
        (session) => inspectAuthorityUpgrade(session, schema),
      );
    }
    const manifest = enabled("test-manifest")
      ? await measure(
        schema,
        "test-manifest",
        (session) => testAuthorityManifest(session, schema),
      )
      : enabled("authority-v13")
      ? await testAuthorityManifest(db, schema)
      : undefined;
    if (enabled("authority-v13")) {
      await measure(
        schema,
        "authority-v13",
        (session) => upgradeAuthoritySchema(session, schema, manifest),
      );
    }
    if (enabled("storage-v14")) {
      await db.query(
        `INSERT INTO "${schema}".authorization_sessions(namespace,tenant,id,principal,expires_at) SELECT 'archive','synthetic','session-'||i,'principal-'||i,'2030-01-01'::timestamptz FROM generate_series(1,1000) i ON CONFLICT DO NOTHING`,
      );
      await measure(
        schema,
        "storage-v14",
        (session) => upgradeCredentialEffects(session, schema),
      );
      const sessions = (await db.query<{ count: string }>(
        `SELECT count(*) FROM "${schema}".authorization_sessions`,
      )).rows[0].count;
      if (Number(sessions) !== 1000) {
        throw new Error("Sessions changed during v14.");
      }
    }
    report.databaseBytes =
      (await db.query("SELECT pg_database_size(current_database()) AS bytes"))
        .rows[0].bytes;
    await saveReport();
    if (arg("discard-schema", "no") === "yes" && enabled("storage-v14")) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.query("CHECKPOINT");
    }
  }
} finally {
  await managed.close();
}
