/**
 * What an agent is sent of a long conversation. With history summarized,
 * nothing leaves before the tail's budget says so, and that budget counts
 * what a prompt really carries: files, transcripts, tool steps. Without it,
 * a window that moves in batches, so the prompt's start holds between them.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Prompt, tool } from "../chat/mod.ts";
import { history, type Summary } from "../history/mod.ts";
import { IMAGE, PAGE, pagesOf, weigh } from "../history/shared/weight.ts";
import { windowStart } from "../chat/shared/lineage.ts";
import { test } from "../../../testing/mod.ts";

const text = (m: LlmMessage) => m.text ?? "";
const said = (messages: LlmMessage[]) => messages.map(text).join("\n");
const b64 = (s: string) => btoa(s);

/**
 * An agent that answers "ok", or, asked for a task, fetches twice first; and
 * a summarizer that writes "S<n>". What each of the agent's calls was sent.
 */
function cast(settings: Record<string, unknown> = {}, withHistory = true) {
  const sent: LlmMessage[][] = [];
  const summarized: string[] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const last = text(messages.at(-1)!);
      if (connection.model === "cheap") {
        summarized.push(last);
        yield { type: "text", text: `S${summarized.length}` };
        return;
      }
      sent.push(messages);
      const asked = messages.findLastIndex((m) => m.role === "user" && /task \d+/.test(text(m)));
      const fetched = messages.slice(asked + 1).filter((m) => m.role === "tool").length;
      if (asked >= 0 && asked === messages.findLastIndex((m) => m.role === "user") && fetched < 2) {
        yield { type: "tool_call", call: { id: `f${sent.length}`, name: "fetch", input: {} } };
      } else yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: { agent: { instructions: "Help.", model: "script/main", tools: ["fetch"] } },
      tools: {
        fetch: tool({ description: "Fetches.", run: () => `page ${"x".repeat(4_000)}` }),
      },
      ...(withHistory ? { history: { summarizer: "script/cheap", ...settings } } : {}),
    },
    adapters: { llm: { script } },
  });
  return { sent, summarized, app };
}

async function run(settings: Record<string, unknown>, withHistory = true) {
  const { sent, summarized, app } = cast(settings, withHistory);
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...(withHistory ? [history] : []), app],
  });
  let thread: string | undefined;
  const say = async (words: string, files?: unknown[]) => {
    thread = (await runtime.call<{ thread: string }>("chat.send", {
      thread,
      text: words,
      from: "ana",
      ...(files ? { files } : {}),
    })).thread;
    await runtime.idle();
  };
  const prompt = () => runtime.query<Prompt>("thread.prompt", { thread, agent: "agent" });
  return { runtime, sent, summarized, say, prompt, thread: () => thread! };
}

test("weights: text by bytes, an image at a large one's cost, a PDF by its pages", () => {
  const pdf = b64("%PDF-1.4 /Type /Pages /Count 3 /Type /Page /Type/Page /Type /Page %%EOF");
  assertEquals(pagesOf(pdf), 3);
  assertEquals(pagesOf(b64("%PDF compressed, no page objects")), 1);
  assertEquals(
    weigh([
      { role: "user", text: "abcdefgh", files: [{ name: "a.png", type: "image/png", data: "" }] },
      { role: "user", text: "", files: [{ name: "b.pdf", type: "application/pdf", data: pdf }] },
      { role: "assistant", toolCalls: [{ id: "1", name: "go", input: { a: 1 } }] },
      { role: "tool", toolCallId: "1", text: "x".repeat(400) },
    ]),
    2 + IMAGE + 3 * PAGE + 3 + 100,
  );
});

test("summarized: short messages all stay whole until the budget is spent, not 50 of them", async () => {
  const { runtime, sent, summarized, say } = await run({});
  try {
    for (let i = 0; i < 40; i++) await say(`short ${i}`);
    // 80 messages, far under the budget: every one is sent, and nothing is summarized.
    assertEquals(sent.at(-1)!.length, 79);
    assertStringIncludes(said(sent.at(-1)!), "ana: short 0");
    assertEquals(summarized, []);
    // Each prompt starts as the last one did.
    for (let i = 1; i < sent.length; i++) {
      assertEquals(sent[i].slice(0, sent[i - 1].length - 1), sent[i - 1].slice(0, -1));
    }
  } finally {
    await runtime.close();
  }
});

test("summarized: tool steps count, leave without a line, and the latest request stays whole", async () => {
  // Each fetch is about 1,000 tokens: two a task, so the tail overflows on the third task.
  const { runtime, sent, summarized, say, prompt, thread } = await run({ tail: [2_500, 5_000] });
  try {
    for (let i = 0; i < 4; i++) await say(`task ${i}`);
    const p = await prompt();
    const last = said(p.history);
    assertStringIncludes(last, "Earlier in this conversation, summarized");
    assertStringIncludes(last, "ana: task 3");
    // What a prompt carries stays near the budget: the older fetches went.
    const kept = p.history.filter((m) => m.role === "tool").length;
    assert(kept > 0 && kept <= 4, `${kept} fetches kept`);
    assert(weigh(p.history) < 5_000 + 500, `${weigh(p.history)} tokens`);
    // Only what was said became lines (short ones, as they are): never the fetches.
    const lines = await runtime.query<Summary[]>("summary.of", { thread: thread() });
    assert(lines.some((l) => l.text.includes("task 0")), "the first request is a line");
    assert(lines.every((l) => !l.text.includes("xxxx")), "never a fetch");
    assertEquals(summarized, [], "short lines need no summarizer");
    // Within a turn, nothing is cut: each fetch's call saw the request.
    assert(sent.every((messages) => /task \d+/.test(said(messages))), "each call saw its request");
  } finally {
    await runtime.close();
  }
});

test("summarized: files count, so a few images move the tail where their text alone wouldn't", async () => {
  const { runtime, summarized, say, prompt } = await run({ tail: [1_000, 3_000] });
  try {
    const png = { name: "a.png", type: "image/png", data: b64("\x89PNG...") };
    await say("look", [png]);
    await say("and this", [png]);
    assertEquals(summarized.length, 0, "two images and their answers fit");
    await say("one more", [png]);
    // Past 3,000 tokens: the first image's message left, as a line, while the text alone is tiny.
    const p = await prompt();
    assertStringIncludes(said(p.history), "Earlier in this conversation, summarized");
    assert(!said(p.history).includes("ana: look"), "the first one is a line now");
    assertStringIncludes(said(p.history), "ana: one more");
  } finally {
    await runtime.close();
  }
});

test("unsummarized: the window holds 50 to 100 and drops 50 at a time", async () => {
  assertEquals([0, 100, 101, 149, 150, 199, 200].map(windowStart), [0, 0, 50, 50, 100, 100, 150]);
  const { runtime, sent, say } = await run({}, false);
  try {
    for (let i = 0; i < 80; i++) await say(`short ${i}`);
    // The prompt's start changed only when the window dropped 50: at 101 and 151 messages seen.
    const first = (messages: LlmMessage[]) => JSON.stringify({ ...messages[0], cache: undefined });
    const breaks = sent.flatMap((messages, i) =>
      i && first(messages) !== first(sent[i - 1]) ? [i] : []
    );
    assertEquals(breaks, [50, 75]);
    assert(sent.every((messages) => messages.length <= 100));
  } finally {
    await runtime.close();
  }
});
