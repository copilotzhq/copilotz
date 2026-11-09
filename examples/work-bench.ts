/**
 * What an agent's work costs: an agent working for a person, in one of many
 * spaces. 1,000 spaces, 50 notes each; the person is a member of 500 of them,
 * and the agent, as the app's own agents are, of every one. Each figure is a
 * whole call through the runtime (a job on an executor, its ops at the
 * owner), as the agent for the person, in one space:
 *
 * - **one space:** a query naming the space it works in, the latest 50;
 * - **all it reaches:** a query naming none (the rules say what it reaches);
 * - **a turn's work:** an Action that reads the space 10 times, everything it
 *   reaches once, writes a note there, and calls another Action (`people`),
 *   which reads once more.
 *
 * And, for comparison, the person themselves (no agent), and the agent for
 * the person with no space named (an app without spaces).
 *
 *   deno run -A examples/work-bench.ts                 SQLite (a temporary file)
 *   deno run -A examples/work-bench.ts --postgres=URL  PostgreSQL (a temporary schema)
 *   … --runs=400                                       more runs per figure (200)
 *
 * Median and p95 ms, SQLite (2026-11-08, local), before "who, for whom,
 * where" (design/work.md) and after:
 *
 *   see design/work.md, "What it costs".
 */
import { parseArgs } from "@std/cli/parse-args";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  people,
} from "../runtime/mod.ts";
import { sqliteStore } from "../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../stores/sql/postgres/mod.ts";
import { access } from "../plugins/access/mod.ts";

const args = parseArgs(Deno.args, { string: ["postgres", "runs"] });
const SPACES = 1_000, NOTES = 50, MINE = 500;
const RUNS = Number(args.runs ?? 200);
const path = await Deno.makeTempFile({ suffix: ".sqlite" });
const store = args.postgres
  ? await postgresStore({ url: args.postgres, schema: `wb_${crypto.randomUUID().slice(0, 8)}` })
  : await sqliteStore({ path });
// Closing the store drops the Postgres schema: the runtime closes it.
if ("drop" in store) Object.assign(store, { close: (store as { drop(): Promise<void> }).drop });

const text = { type: "string" } as const;
const latest = (notes: { find: (...a: unknown[]) => unknown }, space?: string, limit = 50) =>
  notes.find(space ? { in: space } : {}, { sort: { at: -1 }, limit });

const app = definePlugin({
  name: "bench",
  // Notes keep labels: what a turn read elsewhere goes with what it writes (design/access.md).
  resources: { shared: { note: { labels: true } } },
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, at: text, text }, required: ["in"] },
      indexes: [["in", "at"], ["at"]],
      queries: {
        // Anyone asks: the rules keep what each reads to what they reach.
        latest: {
          allow: () => true,
          run: (notes, p: { in?: string }) => latest(notes as never, p.in),
        },
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
      input: {
        type: "object",
        properties: { member: text, n: { type: "number" }, step: { type: "number" } },
        required: ["member", "n", "step"],
      },
      run: async (ctx, { member, n, step }) => {
        const spaces = [...new Set(Array.from({ length: n }, (_, i) => (i * step) % SPACES))];
        for (let at = 0; at < spaces.length; at += 500) {
          await ctx.db.collection("member").insertMany(
            spaces.slice(at, at + 500).map((s) => ({
              _id: `p${s}|${member}`,
              member,
              space: `p${s}`,
              role: "editor",
            })),
          );
        }
      },
    }),
    // What a turn's step does, roughly: reads where it works, looks wider once, writes, calls.
    "bench.work": defineAction({
      input: { type: "object", properties: { space: text, n: { type: "number" } } },
      allow: () => true,
      run: async (ctx, { space, n }) => {
        const notes = ctx.db.collection("note");
        for (let i = 0; i < 10; i++) await latest(notes as never, space, 10);
        await latest(notes as never, undefined, 10);
        await notes.insertOne({
          _id: `w${n}`,
          in: space!,
          at: new Date(Date.UTC(2027, 0, 1) + n! * 1000).toISOString(),
          text: "a note the agent wrote",
        });
        await ctx.call("bench.inner", { space });
      },
    }),
    "bench.inner": defineAction({
      input: { type: "object", properties: { space: text } },
      allow: people,
      run: async (ctx, { space }) => await latest(ctx.db.collection("note") as never, space, 10),
    }),
  },
});

const runtime = await createRuntime({ store, plugins: [...access, app] });
try {
  for (let from = 0; from < SPACES * NOTES; from += 5_000) {
    await runtime.call("bench.fill", { from });
  }
  // The person in 500 spaces (every other one); the agent in all of them, as core agents are.
  await runtime.call("bench.join", { member: "person:ana", n: MINE, step: 2 });
  await runtime.call("bench.join", { member: "agent:north", n: SPACES, step: 1 });
  await runtime.idle();

  const time = async (label: string, run: (i: number) => Promise<unknown>) => {
    for (let i = 0; i < 20; i++) await run(-1 - i);
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      await run(i);
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    const at = (q: number) => runs[Math.min(runs.length - 1, Math.floor(q * runs.length))];
    console.log(
      `${label.padEnd(46)} median ${at(0.5).toFixed(2).padStart(6)} ms   p95 ${
        at(0.95).toFixed(2).padStart(6)
      } ms`,
    );
  };
  const ana: Actor = { kind: "person", id: "ana" };
  // Where it works. (Before `in`, an agent carried where it worked as `at`, which labels read:
  // the figures from before were taken with `at: "p8"` too.)
  const north: Actor = { kind: "agent", id: "north", for: ana, in: "p8" };
  const nowhere: Actor = { kind: "agent", id: "north", for: ana };
  let n = 0;
  for (
    const [who, actor] of [["agent for person, in a space", north], ["person", ana], [
      "agent for person, no space",
      nowhere,
    ]] as const
  ) {
    await time(`${who} · one space`, () => runtime.query("note.latest", { in: "p8" }, { actor }));
    await time(`${who} · all it reaches`, () => runtime.query("note.latest", {}, { actor }));
    await time(
      `${who} · a turn's work`,
      () => runtime.call("bench.work", { space: "p8", n: n++ }, { actor }),
    );
  }
} finally {
  await runtime.close();
  await Deno.remove(path).catch(() => {});
}
