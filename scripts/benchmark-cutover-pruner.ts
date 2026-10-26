/** Synthetic PostgreSQL memory rehearsal; one mode/process at a time. */
import { seedNoise } from "./prune-retained-history.test.ts";
import { restoreRetainedFixture } from "./fixtures/retained-upgrade/load.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { pruneRetainedHistory } from "./prune-retained-history.ts";
import { assertEquals } from "@std/assert";
const url = Deno.env.get("PRUNE_TEST_DATABASE_URL");
if (
  !url || !/^postgres(?:ql)?:\/\/[^/]+:55439\/cutover_[a-z0-9_]+$/.test(url)
) {
  throw new Error(
    "Use PRUNE_TEST_DATABASE_URL on port 55439, database cutover_*.",
  );
}
const db = await createTestDatabase({
  url,
  pgPoolMax: 1,
  requestTimeoutMs: 86_400_000,
});
const schema = "cutover_benchmark";
const mode = Deno.args[0];
try {
  if (mode === "seed") {
    await restoreRetainedFixture(db, schema);
    for (
      const row of (await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1",
        [schema],
      )).rows
    ) {
      await db.query(
        `ALTER TABLE "${schema}"."${row.tablename}" SET (autovacuum_enabled=false)`,
      );
    }
    await seedNoise(db, schema, 300000);
    // 200k bodies carry 1.8 GB of logical payload; TOAST compression keeps the
    // synthetic fixture small on disk. Planner must still decode those bytes.
    await db.query(
      `UPDATE "${schema}".event_bodies SET body=body || jsonb_build_object('padding',repeat('synthetic payload ',500)) WHERE namespace='noise'`,
    );
    await db.query(
      `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('graph-source','noise','message','source','{}'),('graph-target','noise','message','target','{}')`,
    );
    await db.query(
      `INSERT INTO "${schema}".edges(id,namespace,source_node_id,target_node_id,type,data)
      SELECT 'edge-'||n,'noise','graph-source','graph-target','link',jsonb_build_object('note','synthetic edge', 'padding',repeat('edge data ',20)) FROM generate_series(1,600000) n`,
    );
    // References exercise exact refusal parity without joining all histories.
    await db.query(
      `UPDATE "${schema}".edges SET data=data||'{"eventId":"noise-0"}'::jsonb WHERE id='edge-1'`,
    );
    console.log(
      JSON.stringify(
        (await db.query(`SELECT pg_database_size(current_database()) AS bytes`))
          .rows[0],
      ),
    );
  } else if (mode === "before" || mode === "after") {
    const run = mode === "before"
      ? (await import(Deno.env.get("PRUNE_BENCH_BASELINE")!))
        .pruneRetainedHistory
      : pruneRetainedHistory;
    let peakRss = Deno.memoryUsage().rss;
    let ticks = 0;
    const timer = setInterval(() => {
      peakRss = Math.max(peakRss, Deno.memoryUsage().rss);
      if (++ticks % 50 === 0) {
        Deno.writeTextFileSync(
          `/tmp/cutover-pruner-${mode}-memory.json`,
          JSON.stringify({ peakRss, ...Deno.memoryUsage() }),
        );
      }
    }, 20);
    try {
      const report = await run(db, {
        schema,
        eventTypes: [
          "copilotz.schedules.tick.*",
          "copilotz.server.*",
          "sandboxEnvironment.updated",
        ],
        progress: (message: string) => {
          peakRss = Math.max(peakRss, Deno.memoryUsage().rss);
          console.error(message);
        },
      });
      peakRss = Math.max(peakRss, Deno.memoryUsage().rss);
      const path = Deno.env.get("PRUNE_BENCH_REPORT") ??
        "/tmp/cutover-pruner-before-report.json";
      const stable = { ...report, elapsedMs: 0 };
      if (mode === "before") {
        await Deno.writeTextFile(path, JSON.stringify(stable));
      } else if (mode === "after") {
        assertEquals(stable, JSON.parse(await Deno.readTextFile(path)));
      }
      console.log(
        JSON.stringify({
          mode,
          peakRss,
          elapsedMs: report.elapsedMs,
          before: report.before,
          deleteCounts: report.deleteCounts,
          parity: mode === "after",
        }),
      );
    } finally {
      clearInterval(timer);
    }
  } else throw new Error("Specify seed, before or after.");
} finally {
  await db.close();
}
