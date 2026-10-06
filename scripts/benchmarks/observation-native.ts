// deno-lint-ignore-file no-explicit-any
// deno-lint-ignore no-import-prefix -- Opt-in benchmark dependency, not a library runtime dependency.
import pg from "npm:pg@8.23.1";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
  .replace(/\/$/, "");
export const url = Deno.env.get("COPILOTZ_BENCH_POSTGRES_URL");
if (!url) {
  throw new Error(
    "Set COPILOTZ_BENCH_POSTGRES_URL to an isolated localhost PostgreSQL database before running this benchmark.",
  );
}
const databaseUrl = new URL(url);
if (
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)
) {
  throw new Error(
    "This benchmark permits only an explicitly configured localhost PostgreSQL database.",
  );
}
export function benchmarkRoot(mode: string) {
  if (mode === "current") return repositoryRoot;
  if (mode !== "baseline") {
    throw new Error("Benchmark mode must be current or baseline.");
  }
  const baseline = Deno.env.get("COPILOTZ_BENCH_BASELINE_ROOT");
  if (!baseline) {
    throw new Error(
      "Baseline mode requires COPILOTZ_BENCH_BASELINE_ROOT pointing to an archived checkout.",
    );
  }
  return resolve(baseline);
}
export function benchmarkSchema(kind: "idle" | "stream", mode: string) {
  if (mode !== "current" && mode !== "baseline") {
    throw new Error("Invalid benchmark mode.");
  }
  const name = `bench_observations_${kind}_${mode}`;
  if (!/^bench_observations_(idle|stream)_(current|baseline)$/.test(name)) {
    throw new Error("Refusing an unsafe benchmark schema.");
  }
  return name;
}
export async function recordResult(filename: string, result: unknown) {
  const output = Deno.env.get("COPILOTZ_BENCH_OUTPUT_DIR");
  if (!output) return;
  await Deno.mkdir(output, { recursive: true });
  await Deno.writeTextFile(
    resolve(output, filename),
    JSON.stringify(result) + "\n",
    { append: true },
  );
}
export const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function nativeSession(name: string, max = 4) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 0,
    application_name: name,
  });
  const pids = new Set<number>();
  const listeners = new Set<any>();
  let calls = 0, elapsedMs = 0;
  const queries = new Map<string, { calls: number; ms: number }>();
  const counted = (client: any) => ({
    async query(sql: string, params: unknown[] = []) {
      const start = performance.now();
      calls++;
      try {
        return await client.query(sql, params);
      } finally {
        const ms = performance.now() - start;
        elapsedMs += ms;
        const old = queries.get(sql) ?? { calls: 0, ms: 0 };
        old.calls++;
        old.ms += ms;
        queries.set(sql, old);
      }
    },
  });
  pool.on("connect", (client: any) => {
    void client.query("SELECT pg_backend_pid() AS pid").then((r: any) =>
      pids.add(Number(r.rows[0].pid))
    );
  });
  const session = {
    ...counted(pool),
    async transaction(execute: any) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await execute(counted(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async listen(channel: string, handler: any) {
      const client = new pg.Client({
        connectionString: url,
        application_name: name + "_listener",
      });
      await client.connect();
      listeners.add(client);
      pids.add(
        Number(
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        ),
      );
      client.on(
        "notification",
        (notice: any) =>
          handler({ channel: notice.channel, payload: notice.payload }),
      );
      await client.query(`LISTEN "${channel}"`);
      let closed = false;
      return {
        async close() {
          if (!closed) {
            closed = true;
            await client.end();
            listeners.delete(client);
          }
        },
      };
    },
    close() {
      return Promise.resolve();
    },
  };
  return {
    session,
    pids,
    pool,
    reset() {
      calls = 0;
      elapsedMs = 0;
      queries.clear();
    },
    metrics() {
      return {
        calls,
        elapsedMs,
        topQueries: [...queries].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
          .map(([sql, value]) => ({ ...value, sql })),
      };
    },
    async close() {
      await pool.end();
      await Promise.all([...listeners].map((client) => client.end()));
    },
  };
}
function parseCpuTime(value: string) {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return (Number(days) * 86400 +
    clock.split(":").map(Number).reduce((a, b) => a * 60 + b, 0)) * 1000;
}
let linuxClockTicks: number | undefined;
export async function backendCpu(pids: ReadonlySet<number>) {
  if (Deno.build.os === "linux") {
    if (linuxClockTicks === undefined) {
      const clock = await new Deno.Command("getconf", {
        args: ["CLK_TCK"],
        stdout: "piped",
      }).output();
      linuxClockTicks = Number(new TextDecoder().decode(clock.stdout).trim());
      if (!clock.success || !(linuxClockTicks > 0)) {
        throw new Error("Cannot read Linux CPU clock resolution.");
      }
    }
    const result: Record<string, number> = {};
    for (const pid of pids) {
      try {
        const raw = await Deno.readTextFile(`/proc/${pid}/stat`);
        const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
        result[String(pid)] = (Number(fields[11]) + Number(fields[12])) /
          linuxClockTicks * 1000;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return result;
  }
  if (Deno.build.os !== "darwin") {
    throw new Error(
      "Backend CPU attribution supports macOS ps and Linux /proc only.",
    );
  }
  if (!pids.size) return {} as Record<string, number>;
  const out = await new Deno.Command("ps", {
    args: ["-p", [...pids].join(","), "-o", "pid=,time="],
    stdout: "piped",
  }).output();
  return Object.fromEntries(
    new TextDecoder().decode(out.stdout).trim().split("\n").filter(Boolean).map(
      (line) => {
        const [pid, value] = line.trim().split(/\s+/);
        return [
          pid,
          parseCpuTime(value),
        ];
      },
    ),
  );
}
export function cpuDelta(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const lost = Object.keys(before).filter((pid) => after[pid] === undefined);
  return {
    milliseconds: Object.entries(before).reduce(
      (sum, [pid, value]) => sum + (after[pid] ?? value) - value,
      0,
    ),
    lostPids: lost,
    newPids: Object.keys(after).filter((pid) => before[pid] === undefined),
  };
}
export async function pgStats(client: any) {
  return (await client.query(
    "SELECT sum(calls)::float8 calls,sum(total_exec_time)::float8 exec_ms,sum(shared_blks_hit)::float8 hits FROM pg_stat_statements",
  )).rows[0];
}
export { pg };
