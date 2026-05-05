import {
  createCopilotz,
  prepareDatabase,
  writeDatabaseDataDirSnapshot,
} from "../../index.ts";

type Mode =
  | "memory"
  | "fresh-file"
  | "prepare-only"
  | "existing-file"
  | "make-snapshot"
  | "restore";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return Deno.args.find((value) => value.startsWith(prefix))?.slice(
    prefix.length,
  );
}

function modeArg(): Mode {
  const mode = arg("mode") as Mode | undefined;
  if (!mode) throw new Error("--mode is required");
  return mode;
}

function forceGc() {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
}

function rssMb(): number {
  forceGc();
  return Math.round((Deno.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

function mark(label: string, rows: Record<string, unknown>[]) {
  rows.push({ label, rssMb: rssMb(), atMs: performance.now() });
}

function benchConfig(url: string, snapshotPath?: string) {
  return {
    agents: [{
      id: "bench",
      name: "Bench",
      role: "assistant",
      instructions: "Only used for database memory benchmarking.",
    }],
    tools: [],
    dbConfig: {
      url,
      restore: snapshotPath
        ? {
          enabled: true,
          path: snapshotPath,
          snapshotOnShutdown: false,
        }
        : undefined,
    },
  };
}

const mode = modeArg();
const url = arg("url") ?? ":memory:";
const snapshotPath = arg("snapshot");
const rows: Record<string, unknown>[] = [];

mark("start", rows);

if (mode === "prepare-only") {
  await prepareDatabase({ url });
  mark("after-prepare", rows);
  console.log(JSON.stringify({ mode, url, rows }));
  Deno.exit(0);
}

const copilotz = await createCopilotz(benchConfig(
  url,
  mode === "restore" ? snapshotPath : undefined,
));
mark("after-createCopilotz", rows);

await copilotz.db.query("SELECT 1 AS ok");
mark("after-select", rows);

if (mode === "make-snapshot") {
  if (!snapshotPath) throw new Error("--snapshot is required");
  await copilotz.db.query(
    "CREATE TABLE IF NOT EXISTS snapshot_smoke (id TEXT PRIMARY KEY, value TEXT)",
  );
  await copilotz.db.query(
    "INSERT INTO snapshot_smoke (id, value) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    ["one", "restored"],
  );
  mark("after-write-row", rows);
  await writeDatabaseDataDirSnapshot(copilotz.db, { path: snapshotPath });
  mark("after-write-snapshot", rows);
}

if (mode === "restore") {
  await copilotz.db.query(
    "SELECT value FROM snapshot_smoke WHERE id = $1",
    ["one"],
  );
  mark("after-restore-select", rows);
}

await copilotz.shutdown();
mark("after-shutdown", rows);

console.log(JSON.stringify({ mode, url, snapshotPath, rows }));
