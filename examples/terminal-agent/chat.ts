/**
 * A terminal over the runtime: chat with the agents and inspect what the
 * runtime did. The screen is the plugins' terminal Views, drawn with Ink
 * (see plugins/interfaces/terminal), and their commands; this file only wires
 * the runtime and adds debugging commands. Every message prints its timing,
 * database round trips, jobs sent to executors and calls they made back to
 * the owner.
 *
 * `@name` sends a message to that agent. Agents talk to each other with
 * `send_message`; when one asks you something, your next message answers it.
 * `/fork <n>` continues from message n in a fork (to say something else
 * there); `/retry` has your last message answered again, in a fork.
 * `/prompt [agent]` shows exactly what an agent would be sent now.
 *
 *   deno task chat                 in-memory store, no latency
 *   deno task chat --screen        the whole screen (the default prints into the scrollback)
 *   deno task chat --as=ana        your name in the conversation (default "user"); /as bob switches;
 *                                  an email (--as=ana@example.com) receives invitations
 *   deno task chat --rtt=1.7       simulate production round-trip latency (ms)
 *   deno task chat --executors=4   more executors in this process
 *   deno task chat --listen=8787   accept computers (/computer connect says how) and remote
 *                                  executors (deno task executor --port=8787; with
 *                                  --executors=0, only they run the app's code)
 *   deno task chat --sqlite        persist to .data/copilotz.sqlite (or --sqlite=path)
 *   deno task chat --postgres=URL  persist to PostgreSQL (schema "copilotz")
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import { serve } from "@oxian/oxian-js/adapters/deno";
import { createMetrics, createRuntime, definePlugin, type Event } from "../../runtime/mod.ts";
import { otlp, text } from "../../exporters/mod.ts";
import { DatabaseSync } from "node:sqlite";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { withLatency } from "../../stores/latency/mod.ts";
import type { Agent } from "../../plugins/agents/chat/mod.ts";
import { terminalShell } from "../../plugins/interfaces/terminal/terminal.ts";
import { accent as cyan, type Commands, dim, red, terminal } from "../../hosts/terminal/mod.ts";
import { chatTerminal, memoryTerminal } from "../../plugins/agents/terminal.ts";
import { usageTerminal } from "../../plugins/billing/terminal.ts";
import { accessTerminal } from "../../plugins/access/spaces/terminal.ts";
import { computersTerminal } from "../../plugins/compute/computers/terminal.ts";
import app, { EXECUTORS, KEY_FILE, plugins } from "./app.ts";

const args = parseArgs(Deno.args, {
  string: ["rtt", "executors", "listen", "sqlite", "postgres", "as"],
  boolean: ["screen"],
});
const me = args.as || "user";
const agents = app.resources!.agents as Record<string, Agent>;
const rtt = Number(args.rtt ?? 0);
const listen = args.listen ? Number(args.listen) : undefined;
const sqlite = args.sqlite === undefined ? undefined : args.sqlite || ".data/copilotz.sqlite";
if (sqlite) await Deno.mkdir(".data", { recursive: true });
const postgres = args.postgres;
const backing = postgres
  ? await postgresStore({
    url: postgres,
    schema: "copilotz",
    trace: Deno.env.get("COPILOTZ_TRACE_SQL")
      ? (sql) => console.error(`  sql: ${sql.slice(0, 90)}`)
      : undefined,
  })
  : sqlite
  ? await sqliteStore({ path: sqlite })
  : memoryStore();
const store = withLatency(backing, rtt);
// Metrics: shown by /metrics, and sent to an OpenTelemetry collector when one is set.
const otlpEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
const meter = createMetrics({
  resource: { "service.name": "copilotz-terminal-agent" },
  exporters: otlpEndpoint ? [otlp({ url: otlpEndpoint })] : [],
  interval: 15_000,
});
const runtime = await createRuntime({
  store,
  // What every process has, then how it all looks in this terminal.
  plugins: [
    ...plugins,
    terminalShell,
    chatTerminal,
    memoryTerminal,
    usageTerminal,
    accessTerminal,
    computersTerminal,
    // Computers connect where executors do.
    ...(listen
      ? [definePlugin({
        name: "computers-here",
        resources: { computers: { url: `ws://127.0.0.1:${listen}${EXECUTORS}` } },
      })]
      : []),
  ],
  metrics: meter,
  executors: Number(args.executors ?? 1),
  ...(listen
    ? {
      transports: [{ type: "websocket", config: { path: EXECUTORS } }],
      key: await executorKey(),
    }
    : {}),
});
if (listen) serve({ hypervisor: runtime.hypervisor, hostname: "127.0.0.1", port: listen });

/**
 * The key executors present, kept in a private file so executors on this
 * machine find it whatever order things start in. Created on first use.
 */
async function executorKey() {
  try {
    return (await Deno.readTextFile(KEY_FILE)).trim();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const key = crypto.randomUUID();
  await Deno.mkdir(".data", { recursive: true });
  await Deno.writeTextFile(KEY_FILE, key, { mode: 0o600 });
  return key;
}

/** Debugging: what the runtime did. The conversation itself is the plugins' (their Views and commands). */
const debugging: Commands = {
  "/events": {
    description: "The last events in the log",
    usage: "[n]",
    async run(rest, term) {
      const events: Event[] = await store.events(0, 10_000);
      await term.print(
        events.slice(-(Number(rest) || 10))
          .map((e) => `${dim(`#${e.seq} ${e.type}`)} ${JSON.stringify(e.data)}`).join("\n") ||
          dim("No events yet."),
      );
    },
  },
  "/stats": {
    description: "Round trips, jobs, calls, cache",
    run: (_, term) => term.print(dim(JSON.stringify(runtime.stats()))),
  },
  "/metrics": {
    description: "Metrics, as Prometheus text; a name narrows them",
    usage: "[name]",
    run(rest, term) {
      const lines = text(meter.collect()).split("\n")
        .filter((line) => line && !line.startsWith("#") && (!rest || line.includes(rest)))
        .filter((line) => !line.includes("_bucket{"));
      return term.print(dim(lines.join("\n") || "Nothing measured yet."));
    },
  },
  "/sql": {
    description: "A read-only SQL query on the store",
    usage: "<query>",
    async run(query, term) {
      if (postgres) {
        // A read-only transaction on the store's reading connection.
        try {
          const rows = await (backing as Awaited<ReturnType<typeof postgresStore>>).inspect(query);
          await term.print(rows.length ? table(rows) : dim("(no rows)"));
        } catch (error) {
          await term.print(red(`✗ ${error instanceof Error ? error.message : error}`));
        }
        return;
      }
      if (!sqlite) {
        return await term.print(
          dim("/sql needs a SQL store: deno task chat --sqlite (or --postgres=URL)"),
        );
      }
      // A separate read-only connection: it sees what has committed, like any SQLite client.
      const client = new DatabaseSync(sqlite, { readOnly: true });
      try {
        const rows = client.prepare(query).all();
        await term.print(rows.length ? table(rows) : dim("(no rows)"));
      } catch (error) {
        await term.print(red(`✗ ${error instanceof Error ? error.message : error}`));
      } finally {
        client.close();
      }
    },
  },
};

/** Rows as a plain text table; long values are cut to fit. */
function table(rows: Record<string, unknown>[]) {
  const columns = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const text = v === null ? "NULL" : typeof v === "string" ? v : JSON.stringify(v) ?? "";
    return text.length > 60 ? text.slice(0, 59) + "…" : text;
  };
  const cells = rows.map((row) => columns.map((c) => cell(row[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i])).join("  ");
  return [
    cyan(line(columns)),
    dim(widths.map((w) => "─".repeat(w)).join("  ")),
    ...cells.map(line),
    dim(`(${rows.length} row${rows.length === 1 ? "" : "s"})`),
  ].join("\n");
}

const earlier = sqlite || postgres
  ? (await runtime.query<{ _id: string }[]>("thread.recent", { limit: 1000 })).length
  : 0;
// You, to the runtime: what you do is yours, and you reach your own Personal space
// and the shared spaces you join. New conversations go to your Personal space. Named
// by an email (`--as=ana@example.com`), you're a person with that email: invitations
// to it reach you.
const person = async (name: string) => {
  if (name.includes("@")) await runtime.call("person.set", { person: name, email: name });
  const actor = { kind: "person", id: name };
  const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor });
  return { actor, space };
};
await terminal({
  runtime,
  me,
  ...await person(me),
  // `/as bob`: the same terminal, typed by someone else, in their own space.
  become: person,
  screen: args.screen,
  banner: `Copilotz terminal agents · ${Deno.env.get("OPENAI_API_KEY") ? "OpenAI" : "fake model"}` +
    ` · ${postgres ? "PostgreSQL" : sqlite ? `SQLite ${sqlite}` : "in memory"} · rtt ${rtt} ms · ` +
    (listen ? `computers and executors connect on :${listen}` : "in-process") +
    `\nyou are ${me} · agents: ${
      Object.entries(agents).map(([name, a]) => `@${name}${a.default ? " (default)" : ""}`)
        .join(", ")
    } · /help lists commands` +
    (earlier
      ? `\n${earlier} earlier conversations: /threads lists them, /open <n> continues one.`
      : ""),
  commands: debugging,
  // After each message: how long it took, and what the runtime did for it.
  footer: ({ command, ms, before, after }) =>
    command
      ? undefined
      : `⏱ ${(ms / 1000).toFixed(2)} s · ${after.roundTrips - before.roundTrips} round trips · ${
        after.jobs - before.jobs
      } jobs · ${after.calls - before.calls} calls`,
});
await runtime.close();
Deno.exit(0);
