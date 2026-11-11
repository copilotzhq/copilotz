/**
 * Summarized chat history: every shared message gets a line as it leaves the
 * tail, and every agent's step a line of that agent's own; pairs merge up a
 * tree, the tail and the outline shrink in batches, the newest message stays
 * whole, and zoom opens any line back to the message or the step. A scripted
 * summarizer makes every line predictable.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Prompt, tool } from "../chat/mod.ts";
import { history, type Summary } from "../history/mod.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";
import { attached } from "./fixtures/files.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `h_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";
/** What a fetch finds: long enough that its step's line needs the summarizer. */
const FOUND = `found ${"y".repeat(400)}`;
/** A step's line, as the scripted summarizer writes it: longer than a line, so pairs merge. */
const stepLine = (n: number | string) => `T${n} ${"z".repeat(30)}`;

async function start(make: () => Store | Promise<Store>) {
  const summarizer: string[] = [];
  const turns: LlmMessage[][] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const last = text(messages.at(-1)!);
      if (connection.model === "cheap") {
        summarizer.push(last.split("\n")[0]);
        const compress = last.match(/compress message (\d+)/);
        const step = last.match(/compress step (\d+)/);
        const merge = last.match(/merge lines (\S+) and (\S+),/);
        yield {
          type: "text",
          text: compress
            ? `S${compress[1]}`
            : step
            ? stepLine(step[1])
            : `M(${merge![1]},${merge![2]})`,
        };
        return;
      }
      turns.push(messages);
      const zoom = (id: number | string, n: number) =>
        ({
          type: "tool_call",
          call: { id: `z${turns.length}`, name: "zoom", input: { id, n } },
        }) as const;
      if (last.includes("zoom pair")) yield zoom(0, 2);
      else if (last.includes("zoom one")) yield zoom(0, 1);
      else if (last.includes("zoom step")) yield zoom("s0", 1);
      else if (last.includes("task")) {
        yield { type: "tool_call", call: { id: `f${turns.length}`, name: "fetch", input: {} } };
      } else yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: {
        agent: { instructions: "Help.", model: "script/main", tools: ["fetch"] },
        other: { instructions: "Help too.", model: "script/main" },
      },
      tools: { fetch: tool({ description: "Fetches.", run: () => FOUND }) },
      // The tail in estimated tokens: a long message from ana is 15, the agent's "ok" 3.
      history: { summarizer: "script/cheap", line: 40, tail: [25, 50], outline: [60, 120] },
    },
    adapters: { llm: { script } },
  });
  const runtime = await createRuntime({
    store: await make(),
    plugins: [models, chat, history, app],
  });
  let thread: string | undefined;
  const say = async (words: string, files?: Parameters<typeof attached>[1], to?: string) => {
    thread = (await runtime.call<{ thread: string }>("chat.send", {
      thread,
      text: words,
      from: "ana",
      ...(to ? { to: [to] } : {}),
      // Each uploaded first, then sent by id.
      ...(files ? { files: await attached(runtime, files) } : {}),
    })).thread;
    await runtime.idle();
  };
  const prompt = (agent = "agent") => runtime.query<Prompt>("thread.prompt", { thread, agent });
  return { runtime, summarizer, turns, say, prompt, thread: () => thread! };
}

// Each exchange: ana's message (long: the summarizer writes its line) and the agent's "ok".
const long = (n: number) => `message number ${n} is long enough to need a summary line`;

each("lines, merges and a tail that shrinks in batches; the newest stays whole", async (make) => {
  const { runtime, summarizer, say, prompt, thread } = await start(make);
  // Within the tail (50 tokens), nothing is summarized.
  for (let n = 0; n < 2; n++) await say(long(n));
  assertEquals(summarizer, []);
  for (let n = 2; n < 4; n++) await say(long(n));
  // The 5th message took the tail past 50 tokens: the 3 oldest left it, each with its line. Long
  // ones were compressed; short ones and short pairs needed no call.
  assertEquals(summarizer.filter((s) => s.includes("compress")).length, 2);
  assert(summarizer.every((s) => !s.includes("merge lines 0+1")), "short pairs are joined");
  const nodes = await runtime.query<Summary[]>("summary.of", { thread: thread() });
  assertEquals(nodes.filter((s) => s.level === 0).map((s) => s.text), [
    "S0",
    "agent → ana: ok",
    "S2",
  ]);
  assertEquals(nodes.find((s) => s.level === 1 && s.index === 0)?.text, "S0\nagent → ana: ok");
  // 8 messages: the tail passed 50 tokens, and the oldest became lines.
  const p = await prompt();
  const [summaryBlock, ...whole] = p.history;
  assertStringIncludes(text(summaryBlock), "<chat>\n0+1|S0\n1+1|agent → ana: ok");
  assertEquals(text(whole.at(-1)!), "ok");
  assertEquals(text(whole.at(-2)!), `ana: ${long(3)}`);
  assert(p.tools.some((t) => t.name === "zoom"), "zoom is offered once history is summarized");
  await runtime.close();
});

each("the outline merges its most due pairs when it outgrows its budget", async (make) => {
  const { runtime, summarizer, say, prompt } = await start(make);
  for (let n = 0; n < 12; n++) await say(long(n));
  const block = text((await prompt()).history[0]);
  const lines = block.split("\n").filter((line) => /^\d+\+\d+\|/.test(line));
  // Old lines cover several messages now, recent ones fewer.
  const spans = lines.map((line) => Number(line.split("+")[1].split("|")[0]));
  assert(spans[0] > 1, `the oldest line covers more than one message: ${lines.join(" / ")}`);
  assert(spans[0] >= spans.at(-1)!, "coarse first, fine last");
  assert(summarizer.some((s) => s.includes("merge lines")), "long pairs are merged by the model");
  await runtime.close();
});

each("zoom opens a line into the two it was made from, and a message whole", async (make) => {
  const { runtime, turns, say } = await start(make);
  for (let n = 0; n < 4; n++) await say(long(n));
  await say("zoom pair");
  assertEquals(text(turns.at(-1)!.at(-1)!), "0+1|S0\n1+1|agent → ana: ok");
  await say("zoom one");
  // As the agent is sent it.
  assertEquals(text(turns.at(-1)!.at(-1)!), `0+1|ana: ${long(0)}`);
  await runtime.close();
});

each(
  "a message's files are named in its line, and zoom brings a text file back whole",
  async (make) => {
    const { runtime, turns, say, thread } = await start(make);
    const notes = { name: "notes.txt", type: "text/plain", data: btoa("Ship on Friday.") };
    await say("here", [notes]);
    for (let n = 1; n < 6; n++) await say(long(n));
    // Short, it's its own line: the file named.
    const lines = await runtime.query<Summary[]>("summary.of", { thread: thread() });
    assertEquals(
      lines.find((s) => s.level === 0 && s.index === 0)!.text,
      "ana → agent: here [file notes.txt]",
    );
    await say("zoom one");
    const opened = text(turns.at(-1)!.at(-1)!);
    assertStringIncludes(opened, "0+1|ana: here");
    assertStringIncludes(opened, "Ship on Friday.");
    await runtime.close();
  },
);

each("an agent's steps leave as lines only it is sent, and zoom opens one whole", async (make) => {
  const { runtime, summarizer, turns, say, prompt, thread } = await start(make);
  try {
    // Each task: ana's request, the agent's fetch (a step), its "ok".
    for (let n = 0; n < 3; n++) await say(`task ${n}`);
    const nodes = await runtime.query<Summary[]>("summary.of", { thread: thread() });
    const steps = nodes.filter((s) => s.agent === "agent" && s.level === 0);
    assertEquals(steps[0]?.text, stepLine(0));
    const asked = summarizer.find((s) => s.startsWith("Compaction: compress step 0"));
    assert(asked, "the step was compressed");
    // Its line among the thread's, by when it was written: after the request, before the answer.
    const block = text((await prompt()).history[0]);
    assertStringIncludes(
      block,
      `0+1|ana → agent: task 0\ns0+1|${stepLine(0)}\n1+1|agent → ana: ok`,
    );
    // Another agent here is sent the thread's lines, never the agent's steps.
    const theirs = text((await prompt("other")).history[0]);
    assertStringIncludes(theirs, "0+1|ana → agent: task 0\n1+1|agent → ana: ok");
    assert(!theirs.includes("s0+1"), "not another agent's steps");
    // zoom("s0", 1): the step whole, its call and what it returned.
    await say("zoom step");
    assertEquals(text(turns.at(-1)!.at(-1)!), `s0+1|fetch({}) → ${FOUND}`);
    // Another agent can't open it.
    await say("zoom step", undefined, "other");
    assertEquals(text(turns.at(-1)!.at(-1)!), "Error: no message s0 here.");
  } finally {
    await runtime.close();
  }
});

each("an agent's step lines merge in pairs, and its outline keeps within budget", async (make) => {
  const { runtime, summarizer, say, prompt } = await start(make);
  try {
    for (let n = 0; n < 12; n++) await say(`task ${n}`);
    assert(summarizer.some((s) => s.includes("merge lines s0+1 and s1+1")), "pairs merge");
    const block = text((await prompt()).history[0]);
    const lines = block.split("\n").filter((line) => /^s\d+\+\d+\|/.test(line));
    const spans = lines.map((line) => Number(line.split("+")[1].split("|")[0]));
    assert(spans[0] > 1, `the oldest covers more than one step: ${lines.join(" / ")}`);
    assert(spans[0] >= spans.at(-1)!, "coarse first, fine last");
    const bytes = lines.reduce((sum, line) => sum + line.length - line.indexOf("|"), 0);
    assert(bytes <= 120 + 40, `${bytes} bytes of step lines`);
  } finally {
    await runtime.close();
  }
});

each("an erased chat's summaries go with it", async (make) => {
  const { runtime, say, thread } = await start(make);
  // Closed even when it fails: an open runtime keeps Node's test file from ever exiting.
  try {
    for (let n = 0; n < 6; n++) await say(long(n));
    assert((await runtime.query<Summary[]>("summary.of", { thread: thread() })).length > 0);
    await runtime.call("chat.erase", { thread: thread() });
    await runtime.idle();
    assertEquals(await runtime.query<Summary[]>("summary.of", { thread: thread() }), []);
    assertEquals(await runtime.query("message.history", { thread: thread() }), []);
  } finally {
    await runtime.close();
  }
});
