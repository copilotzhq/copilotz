/**
 * Usage totals at scale: fills the ledger with synthetic uses (one every 30 s
 * from Jan 1), then times totals over everything and over indexed slices (a
 * tenant, a week, a thread): from the records alone, then after closing the
 * days (rollups), and the close itself.
 *
 *   deno run -A examples/ledger-bench.ts sqlite 1000000
 *   deno run -A examples/ledger-bench.ts postgres 1000000   (COPILOTZ_TEST_POSTGRES_URL)
 *
 * Needs disk: about 650 MB per million records (1.3 GB on Postgres). The
 * SQLite file and the Postgres schema are removed at the end.
 *
 * 1,000,000 records (one every 30 s, 50 tenants), M-series laptop, owner cache off:
 *
 *   query                      SQLite: records → rollups   Postgres: records → rollups
 *   everything, by subject           8.4 s → 252 ms              4.0 s → 200 ms
 *   everything, by month             9.2 s → 261 ms              2.4 s → 183 ms
 *   one tenant, by day              107 ms → 9 ms                94 ms → 19 ms
 *   one tenant, one week              3 ms → 2 ms                 3 ms → 11 ms
 *   one thread                        1 ms → 1 ms                 1 ms → 1 ms
 *   latest 100 records                3 ms → 1 ms                 2 ms → 2 ms
 *   closing 347 days (once)               9.7 s                       9.0 s
 */
import { rmSync } from "node:fs";
import { createRuntime, defineAction, definePlugin } from "../runtime/mod.ts";
import { sqliteStore } from "../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../stores/sql/postgres/mod.ts";
import { usagePlugin } from "../plugins/billing/mod.ts";

const fill = definePlugin({
  name: "fill",
  actions: {
    "fill.many": defineAction({
      input: { type: "object", properties: { n: { type: "number" }, offset: { type: "number" } } },
      record: false,
      run: (ctx, { n, offset }) => {
        for (let i = 0; i < n!; i++) {
          const k = offset! + i;
          ctx.record("usage", {
            meter: "llm",
            subject:
              ["openai/gpt-6.1-sol", "openai/gpt-5.4-mini", "anthropic/claude-opus-5-5"][k % 3],
            quantities: { input: 1500 + (k % 700), output: 80, cached: 1200 },
            tags: {
              thread: `t${k % 20000}`,
              agent: ["lead", "researcher"][k % 2],
              tenant: `x${k % 50}`,
            },
            cost: 0.003,
            price: 0.006,
            rated: { cost: "models.dev" },
            at: new Date(Date.UTC(2026, 0, 1) + k * 30_000).toISOString(),
          });
        }
      },
    }),
  },
});

const which = Deno.args[0];
const sizes = Deno.args.slice(1).map(Number);
const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
const store = which === "sqlite" ? await sqliteStore({ path }) : await postgresStore({
  url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!,
  schema: `tb_${crypto.randomUUID().slice(0, 8)}`,
});
// Closing the store drops the Postgres schema: the runtime closes it.
if ("drop" in store) Object.assign(store, { close: (store as { drop(): Promise<void> }).drop });
const runtime = await createRuntime({
  store,
  plugins: [
    usagePlugin,
    definePlugin({
      name: "tenants",
      // Totals by tenant: an index on the ledger, and tenants kept apart in rollups.
      collections: {
        usage: { indexes: [["tags.tenant", "at"]] },
        usageRollup: { indexes: [["tags.tenant", "day"]] },
      },
      resources: { usage: { rollups: { dimensions: ["tags.agent", "tags.tenant"] } } },
    }),
    fill,
  ],
  cache: false,
});
let filled = 0;
for (const target of sizes) {
  const t0 = performance.now();
  while (filled < target) {
    await runtime.call("fill.many", { n: 5000, offset: filled });
    filled += 5000;
  }
  console.log(
    `${which} filled ${target.toLocaleString()} in ${
      ((performance.now() - t0) / 1000).toFixed(0)
    } s`,
  );
  const time = async (label: string, params: unknown, how: string, query = "usage.totals") => {
    for (let i = 0; i < 2; i++) {
      const t = performance.now();
      try {
        const out = await runtime.query<unknown[]>(query, params);
        if (i === 1) {
          console.log(
            `${which} ${target.toLocaleString()} · ${how} · ${label}: ${
              (performance.now() - t).toFixed(0)
            } ms (${out.length} groups)`,
          );
        }
      } catch (error) {
        console.log(
          `${which} ${target.toLocaleString()} · ${label}: FAILED ${String(error).slice(0, 120)}`,
        );
        break;
      }
    }
  };
  const queries = async (how: string) => {
    await time("everything, by subject", { by: ["subject"] }, how);
    await time("everything, by month", { by: ["month"] }, how);
    await time("one tenant, by day", { filter: { "tags.tenant": "x7" }, by: ["day"] }, how);
    await time("one tenant, one week", {
      filter: { "tags.tenant": "x7", at: { $gte: "2026-01-08", $lt: "2026-01-15" } },
    }, how);
    await time("one thread", { filter: { "tags.thread": "t42" } }, how);
    await time("latest 100 records", { limit: 100 }, how, "usage.list");
  };
  await queries("records");
  // Close every day but the last one filled.
  const last = new Date(Date.UTC(2026, 0, 1) + (filled - 1) * 30_000).toISOString().slice(0, 10);
  const through = new Date(Date.parse(last) - 86_400_000).toISOString().slice(0, 10);
  const t1 = performance.now();
  const closed = await runtime.call<{ days: number; rollups: number }>("usage.close", { through });
  console.log(
    `${which} ${target.toLocaleString()} · closed ${closed.days} days into ${closed.rollups} ` +
      `rollups in ${((performance.now() - t1) / 1000).toFixed(1)} s`,
  );
  await queries("rollups");
}
await runtime.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
