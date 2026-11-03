/**
 * What an agent is sent of a long conversation. With history summarized,
 * nothing leaves before the tail's budget says so, and that budget counts
 * what a prompt really carries: files, transcripts, tool steps. Without it,
 * a window that moves in batches, so the prompt's start holds between them.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Store } from "../../../runtime/mod.ts";
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

type Options = { history?: boolean; store?: Store; thinks?: boolean };

/**
 * An agent that answers "ok", or, asked for a task, fetches twice first (and,
 * `thinks`, returns a thought as its state each time); and a summarizer that
 * writes "S<n>". What each of the agent's calls was sent.
 */
function cast(settings: Record<string, unknown>, { history: withHistory = true, thinks }: Options) {
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
      if (thinks) yield { type: "state", state: { data: [`thought ${sent.length}`] } };
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
    actions: {
      "test.legacy": defineAction({
        input: { type: "object", properties: { thread: { type: "string" } } },
        run: (ctx, input) =>
          ctx.as().db.collection("outline").updateOne({ _id: input.thread }, {
            $unset: { complete: "" },
          }),
      }),
    },
  });
  return { sent, summarized, app };
}

async function run(settings: Record<string, unknown>, options: Options = {}) {
  const { sent, summarized, app } = cast(settings, options);
  const runtime = await createRuntime({
    store: options.store ?? memoryStore(),
    plugins: [models, chat, ...(options.history === false ? [] : [history]), app],
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
  return {
    runtime,
    sent,
    summarized,
    say,
    prompt,
    thread: () => thread!,
    into: (t: string) => thread = t,
  };
}

test("weights: text by bytes, an image at a large one's cost, a PDF by its pages, state as told", () => {
  const pdf = b64("%PDF-1.4 /Type /Pages /Count 3 /Type /Page /Type/Page /Type /Page %%EOF");
  assertEquals(pagesOf(pdf), 3);
  assertEquals(pagesOf(b64("%PDF compressed, no page objects")), 1);
  assertEquals(
    weigh([
      { role: "user", text: "abcdefgh", files: [{ name: "a.png", type: "image/png", data: "" }] },
      { role: "user", text: "", files: [{ name: "b.pdf", type: "application/pdf", data: pdf }] },
      {
        role: "assistant",
        toolCalls: [{ id: "1", name: "go", input: { a: 1 } }],
        state: { data: ["encrypted"], tokens: 500 },
      },
      { role: "tool", toolCallId: "1", text: "x".repeat(400) },
    ]),
    2 + IMAGE + 3 * PAGE + 3 + 500 + 100,
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
    // Within a turn, nothing is cut: each call's latest word from ana is its own request.
    const asked = sent.map((messages) => text(messages.findLast((m) => m.role === "user")!));
    assertEquals(asked, [0, 1, 2, 3].flatMap((i) => Array(3).fill(`ana: task ${i}`)));
  } finally {
    await runtime.close();
  }
});

test("summarized: files count, so a few images move the tail where their text alone wouldn't", async () => {
  const { runtime, say, prompt } = await run({ tail: [1_000, 3_000] });
  try {
    const png = { name: "a.png", type: "image/png", data: b64("\x89PNG...") };
    await say("look", [png]);
    await say("and this", [png]);
    // Over 3,000 tokens already, but the four newest shared messages always stay whole.
    assert(!said((await prompt()).history).includes("summarized"), "nothing has left yet");
    await say("one more", [png]);
    // A fifth: the first image's message left, as a line, while the text alone is tiny.
    const p = await prompt();
    assertStringIncludes(said(p.history), "Earlier in this conversation, summarized");
    assertStringIncludes(said(p.history), "0+1|ana → agent: look [file a.png]");
    assert(!said(p.history).includes("ana: look"), "not whole");
    assertStringIncludes(said(p.history), "ana: one more");
    assertEquals(p.history.flatMap((m) => m.role === "user" ? m.files ?? [] : []).length, 2);
  } finally {
    await runtime.close();
  }
});

test("unsummarized: the window holds 50 to 100 and drops 50 at a time", async () => {
  assertEquals([0, 100, 101, 149, 150, 199, 200].map(windowStart), [0, 0, 50, 50, 100, 100, 150]);
  const { runtime, sent, say } = await run({}, { history: false });
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

test("summarized: a big file stays whole while the conversation is about it, then leaves named", async () => {
  const { runtime, say, prompt } = await run({ tail: [500, 1_000] });
  try {
    // Three pages: 6,000 tokens, six times the tail's maximum.
    const pdf = {
      name: "contract.pdf",
      type: "application/pdf",
      data: b64("%PDF-1.4 /Type /Page /Type /Page /Type /Page %%EOF"),
    };
    await say("read this contract", [pdf]);
    const pdfs = async () =>
      (await prompt()).history.flatMap((m) => m.role === "user" ? m.files ?? [] : []).length;
    await say("what does section 4 say?");
    assertEquals(await pdfs(), 1, "still there for the next question");
    await say("and section 5?");
    assertEquals(await pdfs(), 0, "a fifth shared message: it left");
    assertStringIncludes(said((await prompt()).history), "read this contract [file contract.pdf]");
  } finally {
    await runtime.close();
  }
});

test("summarized: a thread whose outline came before steps counted gets the window", async () => {
  const { runtime, sent, say, thread } = await run({});
  try {
    for (let i = 0; i < 70; i++) await say(`short ${i}`);
    // As an outline made by an earlier compactor is: not known to hold the whole thread.
    await runtime.call("test.legacy", { thread: thread() });
    await say("and now?");
    // 141 messages in it: the window (50 to 100), not all of them.
    const last = sent.at(-1)!;
    assert(last.length <= 100, `${last.length} messages sent`);
    assertStringIncludes(said(last), "ana: and now?");
    assert(!said(last).includes("ana: short 0\n"), "the oldest aren't sent");
  } finally {
    await runtime.close();
  }
});

test("summarized: after a cut, a model's state from before it goes; its newer state stays", async () => {
  const { runtime, sent, say } = await run({ tail: [30, 60] }, { thinks: true });
  try {
    for (let i = 0; i < 12; i++) await say(`message number ${i} is long enough to count`);
    const last = sent.at(-1)!;
    assertStringIncludes(said(last), "Earlier in this conversation, summarized");
    const thoughts = last.flatMap((m) =>
      m.role === "assistant" && m.state ? [(m.state.data as string[])[0]] : []
    );
    // The whole answers before the last cut lost their thought; those after it kept theirs.
    const answers = last.filter((m) => m.role === "assistant").length;
    assert(thoughts.length > 0 && thoughts.length < answers, `${thoughts.length} of ${answers}`);
    assertEquals(thoughts.at(-1), `thought ${sent.length - 1}`);
  } finally {
    await runtime.close();
  }
});
