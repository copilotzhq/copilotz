/**
 * What access costs: 100,000 notes in 1,000 spaces, read as the system and
 * as a person who is a member of 10, 100 or 500 of them (through the access
 * plugin's rules), the latest 50 each time. Each figure is a full query
 * through the runtime (a job on an executor, its reads at the owner).
 *
 *   deno run -A examples/access-bench.ts                 SQLite (a temporary file)
 *   deno run -A examples/access-bench.ts --postgres=URL  PostgreSQL (a temporary schema)
 *   … --uncached                                         without the owner's read cache
 *
 * Median ms, system → a person in 10 / 100 / 500 spaces (2026-10-28, local):
 *
 *                       one space they reach      everything they reach
 *   cached (both)       0.47 → 0.47 / – / 0.60    0.39 → 0.40 / 0.41 / 0.56
 *   SQLite, uncached    0.54 → 0.54 / – / 1.04    0.45 → 0.71 / 1.59 / 5.43
 *   Postgres, uncached  0.86 → 1.22 / – / 2.91    0.71 → 4.74 / 5.08 / 5.18
 *
 * Memberships change rarely, so the owner's cache answers the rules' reads;
 * a query that names a space it reaches goes to the store unchanged.
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
} from "../runtime/mod.ts";
import { sqliteStore } from "../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../stores/sql/postgres/mod.ts";
import { access } from "../plugins/access/mod.ts";

const args = parseArgs(Deno.args, { string: ["postgres"], boolean: ["uncached"] });
const N = 100_000, SPACES = 1_000;
const path = await Deno.makeTempFile({ suffix: ".sqlite" });
const store = args.postgres
  ? await postgresStore({ url: args.postgres, schema: `ab_${crypto.randomUUID().slice(0, 8)}` })
  : await sqliteStore({ path });
// Closing the store drops the Postgres schema: the runtime closes it.
if ("drop" in store) Object.assign(store, { close: (store as { drop(): Promise<void> }).drop });

const text = { type: "string" } as const;
const app = definePlugin({
  name: "bench",
  resources: { shared: { note: {} } },
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, at: text, text }, required: ["in"] },
      indexes: [["in", "at"], ["at"]],
      queries: {
        latest: (notes, p: { in?: string }) =>
          notes.find(p.in ? { in: p.in } : {}, { sort: { at: -1 }, limit: 50 }),
      },
    }),
  },
  actions: {
    "bench.fill": defineAction({
      input: { type: "object", properties: { from: { type: "number" } }, required: ["from"] },
      run: async (ctx, { from }) => {
        await ctx.db.collection("note").insertMany(Array.from({ length: 5_000 }, (_, i) => {
          const k = from + i;
          return {
            _id: `n${k}`,
            in: `p${k % SPACES}`,
            at: new Date(Date.UTC(2026, 0, 1) + k * 1000).toISOString(),
            text: "x".repeat(200),
          };
        }));
      },
    }),
    "bench.join": defineAction({
      input: { type: "object", properties: { who: text, n: { type: "number" } } },
      run: async (ctx, { who, n }) => {
        await ctx.db.collection("member").insertMany(Array.from({ length: n! }, (_, i) => ({
          _id: `p${(i * 7) % SPACES}|person:${who}`,
          member: `person:${who}`,
          space: `p${(i * 7) % SPACES}`,
          role: "editor",
        })));
      },
    }),
  },
});

// --uncached: every read goes to the store, as the first read of anything does.
const runtime = await createRuntime({
  store,
  plugins: [...access, app],
  ...(args.uncached ? { cache: false as const } : {}),
});
try {
  for (let from = 0; from < N; from += 5_000) await runtime.call("bench.fill", { from });
  for (const n of [10, 100, 500]) await runtime.call("bench.join", { who: `m${n}`, n });
  await runtime.idle();

  const time = async (label: string, run: () => Promise<unknown>) => {
    for (let i = 0; i < 5; i++) await run();
    const runs: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      await run();
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    console.log(`${label.padEnd(44)} ${runs[20].toFixed(2)} ms`);
  };
  const as = (n: number): Actor => ({ kind: "person", id: `m${n}` });
  await time("system · one space", () => runtime.query("note.latest", { in: "p7" }));
  await time(
    "person (10) · one space they reach",
    () => runtime.query("note.latest", { in: "p7" }, { actor: as(10) }),
  );
  await time(
    "person (500) · one space they reach",
    () => runtime.query("note.latest", { in: "p7" }, { actor: as(500) }),
  );
  await time("system · everything", () => runtime.query("note.latest", {}));
  for (const n of [10, 100, 500]) {
    await time(
      `person (${n}) · all they reach`,
      () => runtime.query("note.latest", {}, { actor: as(n) }),
    );
  }
} finally {
  await runtime.close();
  await Deno.remove(path).catch(() => {});
}
