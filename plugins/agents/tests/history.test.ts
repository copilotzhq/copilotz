/**
 * Summarized chat history: every shared message gets a line as it leaves the
 * tail, pairs merge up a tree, the tail and the outline shrink in batches, the
 * newest message stays whole, and zoom opens any line back to the message. A
 * scripted summarizer makes every line predictable.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Prompt } from "../chat/mod.ts";
import { history, type Summary } from "../history/mod.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";

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

async function start(make: () => Store | Promise<Store>) {
  const summarizer: string[] = [];
  const turns: LlmMessage[][] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const last = text(messages.at(-1)!);
      if (connection.model === "cheap") {
        summarizer.push(last.split("\n")[0]);
        const compress = last.match(/compress message (\d+)/);
        const merge = last.match(/merge lines (\S+) and (\S+),/);
        yield { type: "text", text: compress ? `S${compress[1]}` : `M(${merge![1]},${merge![2]})` };
        return;
      }
      turns.push(messages);
      if (last.includes("zoom pair")) {
        yield { type: "tool_call", call: { id: "z1", name: "zoom", input: { id: 0, n: 2 } } };
      } else if (last.includes("zoom one")) {
        yield { type: "tool_call", call: { id: "z2", name: "zoom", input: { id: 0, n: 1 } } };
      } else yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: { agent: { instructions: "Help.", model: "script/main" } },
      history: { summarizer: "script/cheap", line: 40, tail: [100, 200], outline: [60, 120] },
    },
    adapters: { llm: { script } },
  });
  const runtime = await createRuntime({
    store: await make(),
    plugins: [models, chat, history, app],
  });
  let thread: string | undefined;
  const say = async (words: string) => {
    thread =
      (await runtime.call<{ thread: string }>("chat.send", { thread, text: words, from: "ana" }))
        .thread;
    await runtime.idle();
  };
  const prompt = () => runtime.query<Prompt>("thread.prompt", { thread, agent: "agent" });
  return { runtime, summarizer, turns, say, prompt, thread: () => thread! };
}

// Each exchange: ana's message (long: the summarizer writes its line) and the agent's "ok".
const long = (n: number) => `message number ${n} is long enough to need a summary line`;

each("lines, merges and a tail that shrinks in batches; the newest stays whole", async (make) => {
  const { runtime, summarizer, say, prompt, thread } = await start(make);
  // Within the tail (200 bytes), nothing is summarized.
  for (let n = 0; n < 2; n++) await say(long(n));
  assertEquals(summarizer, []);
  for (let n = 2; n < 4; n++) await say(long(n));
  // The 5th message took the tail past 200 bytes: the 3 oldest left it, each with its line. Long
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
  // 8 messages: the tail passed 200 bytes, and the oldest became lines.
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
  assertEquals(text(turns.at(-1)!.at(-1)!), `0+1|ana → agent: ${long(0)}`);
  await runtime.close();
});
