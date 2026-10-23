import { resourceUsage } from "node:process";
/** Synthetic, compressed-padding fixture. One process; own schema always removed. */
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { restoreRetainedFixture } from "./fixtures/retained-upgrade/load.ts";
import { encodeEventBody } from "../runtime/events/body-store.ts";
import { digestContent } from "../runtime/content/digest.ts";
import { createMemoryBodyStore } from "../runtime/content/body-store.ts";
import {
  prepareRetainedDataUpgrade,
  upgradeActionLifecycle,
} from "../runtime/actions/upgrade.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";
import { migrateOwnerKeys } from "../runtime/actions/migrate-owner-keys.ts";
import { upgradeAuthoritySchema } from "../runtime/authorization/upgrade.ts";
import { upgradeCredentialEffects } from "../runtime/authorization/credentials-upgrade.ts";
import { retainedRows } from "../runtime/content/offline-rows.ts";
const arg = (key: string, fallback: string) =>
  Deno.args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ??
    fallback;
const url = new URL(
  arg("url", "postgres://postgres@localhost:55439/cutover_memory"),
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.port !== "55439" || !/^\/cutover_[a-z0-9_]+$/.test(url.pathname)
) throw new Error("Use local PostgreSQL port 55439 and cutover_* database.");
const schema = "synthetic_memory_" + crypto.randomUUID().replaceAll("-", "");
const db = await createTestDatabase({
  url: url.href,
  statementTimeoutMs: null,
  requestTimeoutMs: 86400000,
  pgPoolMax: 1,
});
const bytes = new TextEncoder().encode("synthetic object bytes"),
  digest = await digestContent(bytes);
const base = createMemoryBodyStore({ backendId: "synthetic:scale" });
const store = {
  ...base,
  kind: "object" as const,
  conditionalDelete: false,
  head: ({ bodyId }: { bodyId: string }) =>
    Promise.resolve({
      bodyId,
      state: "ready" as const,
      byteLength: bytes.length,
      digest,
      versionToken: `synthetic:${bodyId}`,
      maintenanceVersion: 1,
      mediaType: "text/plain",
    }),
  readRange: ({ offset, end }: { offset: number; end: number }) =>
    Promise.resolve(bytes.slice(offset, end)),
};
const storage = {
  storeFor: (loc: { backendId: string }) =>
    loc.backendId === store.backendId ? store : undefined,
  concurrency: 16,
};
// Deno exposes the platform rusage unit (bytes on Darwin, KiB on Linux).
const rss = () =>
  Math.max(
    Deno.memoryUsage().rss,
    resourceUsage().maxRSS * (Deno.build.os === "darwin" ? 1 : 1024),
  );
let peak = rss();
const steps: Record<string, unknown>[] = [];
const timer = setInterval(
  () => peak = Math.max(peak, rss()),
  20,
);
async function measure<T>(name: string, run: () => Promise<T>) {
  const start = performance.now();
  const result = await run();
  peak = Math.max(peak, rss());
  const step = {
    name,
    seconds: (performance.now() - start) / 1000,
    peakRssBytes: peak,
  };
  steps.push(step);
  console.error(JSON.stringify(step));
  return result;
}
try {
  await measure("fixture", async () => {
    await restoreRetainedFixture(db, schema);
    const encoded = await encodeEventBody({ text: "synthetic ".repeat(1334) });
    for (let start = 0; start < 140000; start += 2000) {
      await db.query(
        `INSERT INTO "${schema}".event_bodies(namespace,event_body_id,schema_version,body,digest) SELECT 'archive','scale-body-'||i,1,$3::jsonb,$4 FROM generate_series($1::integer,$2::integer) i`,
        [start, start + 1999, encoded.body, encoded.digest],
      );
      await db.query(
        `INSERT INTO "${schema}".events(id,schema_version,type,namespace,payload,metadata,correlation_id) SELECT 'scale-event-'||i,7,'synthetic.history','archive',jsonb_build_object('dataRef',jsonb_build_object('eventBodyId','scale-body-'||i,'schemaVersion',1,'mediaType','application/json')),'{}','synthetic-correlation-'||i FROM generate_series($1::integer,$2::integer) i`,
        [start, start + 1999],
      );
    }
    for (let start = 0; start < 60000; start += 2000) {
      await db.query(
        `INSERT INTO "${schema}".nodes(namespace,id,type,name,data) SELECT 'archive','scale-node-'||i,'synthetic','synthetic',jsonb_build_object('padding',repeat('synthetic ',778)) || CASE WHEN i<20000 THEN jsonb_build_object('location',jsonb_build_object('kind','object','backendId',$3::text,'key','scale-object-'||i),'byteLength',$4::integer,'digest',$5::text) ELSE '{}'::jsonb END FROM generate_series($1::integer,$2::integer) i`,
        [start, start + 1999, store.backendId, bytes.length, digest],
      );
    }
    await db.query(
      `INSERT INTO "${schema}".edges(id,namespace,source_node_id,target_node_id,type,data)
      SELECT 'scale-edge-'||i,'archive','scale-node-'||(i%60000),'scale-node-'||((i+1+i/60000)%60000),
        CASE WHEN i%10=0 THEN 'has_asset' ELSE 'synthetic_relation' END,'{}'::jsonb
      FROM generate_series(0,619999) i`,
    );
    await db.query(`ANALYZE "${schema}".edges`);
    await db.query(`ANALYZE "${schema}".event_bodies`);
    await db.query(`ANALYZE "${schema}".nodes`);
    await db.query(`ANALYZE "${schema}".events`);
  });
  if (arg("mode", "after") === "eager-control") {
    // Reproduce the former retained-payload lifetime, with a safety cap instead of OOM.
    const rows = [];
    await measure("eager-control", async () => {
      for await (const row of retainedRows(db, schema)) {
        rows.push(row);
        peak = Math.max(peak, rss());
        if (peak > 2.5 * 1024 ** 3) {
          console.error(
            `Eager control stopped at ${rows.length} rows at the 2.5 GiB safety cap.`,
          );
          break;
        }
      }
    });
    console.log(
      JSON.stringify({
        mode: "eager-control",
        retainedRows: rows.length,
        totalRows: 200017,
        peakRssBytes: peak,
        steps,
      }),
    );
  } else {
    const plan = await measure(
      "prepare",
      () => prepareRetainedDataUpgrade(db, schema, storage),
    );
    if (!plan) throw new Error("Missing plan");
    await measure("finalize-v11", async () => {
      try {
        await upgradeActionLifecycle(db, schema, {
          ...storage,
          plan,
          reviewedFingerprint: plan.fingerprint,
        });
      } catch (error) {
        if (
          (error as { code?: string }).code !==
            "copilotz_upgrade_owner_keys_required"
        ) throw error;
      }
    });
    const adapter = await testSecretAdapter();
    await measure(
      "owner-keys-v12",
      () =>
        migrateOwnerKeys({
          session: db,
          schema,
          sourceAdapter: adapter,
          masterAdapter: adapter,
          readExternalBody: () =>
            Promise.resolve({ bytes, mediaType: "text/plain" }),
        }),
    );
    const authority = await measure(
      "authority-inventory",
      () => testAuthorityManifest(db, schema),
    );
    await measure(
      "authority-v13",
      () => upgradeAuthoritySchema(db, schema, authority),
    );
    await measure("storage-v14", () => upgradeCredentialEffects(db, schema));
    const report = {
      mode: "after",
      measurement: "process RSS and OS high-water mark",
      eventBodies: 140000,
      nodes: 60000,
      externalLocations: 20000,
      edges: 620000,
      eventBodyBytes: 12000,
      nodeBytes: 7000,
      peakRssBytes: peak,
      planBytes: JSON.stringify(plan).length,
      steps,
    };
    console.log(JSON.stringify(report, null, 2));
    if (peak >= 3_000_000_000) throw new Error("Peak RSS exceeded 3 GB.");
  }
} finally {
  clearInterval(timer);
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.query("CHECKPOINT");
  await db.close();
}
