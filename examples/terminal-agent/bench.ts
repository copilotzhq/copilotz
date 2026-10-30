/**
 * Measures runtime overhead per exchange with instant scripted models, so the
 * numbers are the runtime's own cost: no model time, only actions, processors,
 * storage and database round trips: "round trips" counts reads and commits
 * (what --rtt simulates); "statements" counts the SQL the store actually sends.
 *
 *   deno task bench [--turns=50] [--rtt=1.74] [--remote] [--sqlite] [--postgres=URL] [--ledger]
 *
 * Scenarios: one agent answering (plain, and with a tool call); three agents
 * answering one message in parallel; an agent asking another in a subthread
 * and waiting for its reply; an agent asking the person for approval.
 *
 * `--remote` runs the executor in another process, over Oxian's WebSocket transport.
 * `--ledger` adds the usage plugin, so every model call is also recorded.
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import { serve } from "@oxian/oxian-js/adapters/deno";
import { createExecutor, createRuntime, definePlugin } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { withLatency } from "../../stores/latency/mod.ts";
import chat, { type Message, tool } from "../../plugins/agents/chat/mod.ts";
import models, { fake, type LlmAdapter } from "../../plugins/models/mod.ts";
import usage from "../../plugins/billing/usage/mod.ts";

const args = parseArgs(Deno.args, {
  string: ["turns", "rtt", "executor", "postgres"],
  boolean: ["remote", "sqlite", "ledger"],
});
const turns = Number(args.turns ?? 50);
const rtt = Number(args.rtt ?? 0);

/**
 * Instant models. `fake` echoes or calls the tool it is asked for; `echo`
 * answers; `lead` asks the helper in a subthread, then answers its reply;
 * `asker` asks the person for approval, then answers theirs.
 */
const echo = fake({ delayMs: 0 });
const answers: LlmAdapter = {
  async *generate(request) {
    const last = request.messages.at(-1)!;
    const text = "text" in last ? last.text ?? "" : "";
    const send = (input: Record<string, unknown>) => ({
      type: "tool_call" as const,
      call: { id: crypto.randomUUID(), name: "send_message", input },
    });
    switch (request.connection.model) {
      case "lead":
        yield text.startsWith("helper:")
          ? { type: "text", text: "done" }
          : send({ to: "helper", text: "check this", in: "subthread" });
        return;
      case "asker":
        yield text === "user: yes"
          ? { type: "text", text: "done" }
          : send({ to: "user", text: "May I?" });
        return;
      case "echo":
        yield { type: "text", text: "ok" };
        return;
      default:
        yield* echo.generate(request);
    }
  },
};

/** Every call also reports usage, so the ledger records it as a real model's would. */
const instant: LlmAdapter = {
  async *generate(request) {
    yield* answers.generate(request);
    yield { type: "usage", input: 1200, output: 40, cached: 1000 };
  },
};

const agent = (model: string, tools: string[] = []) => ({
  instructions: "",
  model: `instant/${model}`,
  tools,
});
const bench = definePlugin({
  name: "bench",
  resources: {
    provider: { instant: { adapter: "instant" } },
    agents: {
      assistant: agent("fake", ["roll_dice"]),
      a: agent("echo"),
      b: agent("echo"),
      c: agent("echo"),
      lead: agent("lead", ["send_message"]),
      helper: agent("echo"),
      asker: agent("asker", ["send_message"]),
    },
    tools: { roll_dice: tool({ description: "Roll a die.", run: () => 4 }) },
  },
  adapters: { llm: { instant } },
});

// With --ledger, every model call is also recorded in the usage ledger.
const plugins = [models, chat, ...(args.ledger ? [usage] : []), bench];

const PATH = "/core/executors";

if (args.executor) {
  const url = `ws://127.0.0.1:${args.executor}${PATH}`;
  const executor = createExecutor({
    plugins,
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    key: Deno.env.get("COPILOTZ_EXECUTOR_KEY"),
  });
  await executor.ready;
  await new Promise(() => {});
}

/** Starts the runtime; with `--remote`, its executor is another process. */
async function start(store: Parameters<typeof createRuntime>[0]["store"]) {
  if (!args.remote) return { runtime: await createRuntime({ store, plugins }) };
  const key = crypto.randomUUID();
  const runtime = await createRuntime({
    store,
    plugins,
    key,
    executors: 0,
    transports: [{ type: "websocket", config: { path: PATH } }],
  });
  const listener = serve({ hypervisor: runtime.hypervisor, hostname: "127.0.0.1", port: 0 });
  const port = new URL(String(listener.url)).port;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL(import.meta.url).pathname, `--executor=${port}`],
    env: { COPILOTZ_EXECUTOR_KEY: key },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return {
    runtime,
    async stop() {
      child.kill();
      await child.status;
      await listener.shutdown();
    },
  };
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1];
const p95 = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.95)];

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
/** One exchange in `thread`, from the person's message until nothing is left to do. */
type Exchange = (runtime: Runtime, thread?: string) => Promise<string>;

const say = (input: Record<string, unknown>): Exchange => async (runtime, thread) => {
  const sent = await runtime.call<{ thread: string }>("chat.send", { thread, ...input });
  await runtime.idle();
  return sent.thread;
};

/** The person asks; the agent asks them back; they approve. */
const approval: Exchange = async (runtime, thread) => {
  thread = await say({ text: "go", to: ["asker"] })(runtime, thread);
  const messages = await runtime.query<Message[]>("message.history", { thread });
  const question = messages.findLast((m) => m.from === "asker" && m.to.includes("user"))!;
  return await say({ text: "yes", replyTo: question._id })(runtime, thread);
};

async function scenario(label: string, exchange: Exchange) {
  const backing = args.postgres
    ? await postgresStore({
      url: args.postgres,
      schema: `bench_${crypto.randomUUID().slice(0, 8)}`,
    })
    : args.sqlite
    ? await sqliteStore({ path: Deno.makeTempFileSync({ suffix: ".sqlite" }) })
    : memoryStore();
  const store = withLatency(backing, rtt);
  const { runtime, stop } = await start(store);
  let thread: string | undefined;
  const times: number[] = [];
  const trips: number[] = [];
  const statements: number[] = [];
  const jobs: number[] = [];
  const calls: number[] = [];
  for (let i = 0; i < turns + 5; i++) {
    const before = runtime.stats();
    const sentBefore = backing.roundTrips();
    const started = performance.now();
    thread = await exchange(runtime, thread);
    if (i < 5) continue; // warm-up
    times.push(performance.now() - started);
    const after = runtime.stats();
    trips.push(after.roundTrips - before.roundTrips);
    statements.push(backing.roundTrips() - sentBefore);
    jobs.push(after.jobs - before.jobs);
    calls.push(after.calls - before.calls);
  }
  await stop?.();
  await runtime.close();
  console.log(
    `${label.padEnd(11)} median ${median(times).toFixed(2)} ms · p95 ${p95(times).toFixed(2)} ms` +
      ` · ${median(trips)} round trips (${median(statements)} statements) · ${median(jobs)} jobs` +
      ` · ${median(calls)} calls`,
  );
}

console.log(
  `${turns} turns · rtt ${rtt} ms · ${args.remote ? "remote" : "in-process"} executor · ${
    args.postgres ? "PostgreSQL" : args.sqlite ? "SQLite" : "memory"
  }`,
);
await scenario("plain", say({ text: "hello" }));
await scenario("tool", say({ text: "roll dice please" }));
await scenario("fan-out ×3", say({ text: "hello", to: ["a", "b", "c"] }));
await scenario("ask agent", say({ text: "go", to: ["lead"] }));
await scenario("approval", approval);
