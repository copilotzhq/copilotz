/**
 * An agent's history by age (`history: { maxAge }`): what's older than its
 * window, back from the newest message, stays out of its prompt (summaries
 * of it too) and in the chat, with the history plugin and without. An agent
 * without it sees everything. The start moves in steps, so the prompt only
 * grows between them.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, type Prompt } from "../chat/mod.ts";
import { history } from "../history/mod.ts";
import { ageStart } from "../chat/shared/lineage.ts";
import { test } from "../../../testing/mod.ts";

const HOUR = 3_600_000;
const text = (m: LlmMessage) => m.text ?? "";
const said = (messages: LlmMessage[]) => messages.map(text).join("\n");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const RULES = '<context name="rules">\nbe brief\n</context>';

type Seed = Pick<Message, "from" | "at"> & Partial<Message>;

/**
 * `booker` keeps 4 hours and answers new conversations; `plain` keeps all.
 * Both answer "ok"; the summarizer writes `S<n>` for message n. `test.seed`
 * writes a thread whose messages were written when they say.
 */
async function start(options: { history?: boolean; rules?: boolean } = {}) {
  const sent: Record<string, LlmMessage[][]> = { booker: [], plain: [] };
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const last = text(messages.at(-1)!);
      if (connection.model === "cheap") {
        yield { type: "text", text: `S${last.match(/compress message (\d+)/)?.[1] ?? "?"}` };
        return;
      }
      sent[connection.model].push(messages);
      yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: {
        booker: {
          instructions: "Book.",
          model: "script/booker",
          default: true,
          history: { maxAge: 4 * HOUR },
        },
        plain: { instructions: "Help.", model: "script/plain" },
      },
      // A long message is about 15 tokens: the tail keeps three or four, and nothing merges.
      ...(options.history
        ? { history: { summarizer: "script/cheap", line: 40, tail: [25, 50], outline: [1e6, 2e6] } }
        : {}),
      ...(options.rules ? { context: { rules: { place: "turn" } } } : {}),
    },
    ...(options.rules ? { views: { "context:rules": () => "be brief" } } : {}),
    adapters: { llm: { script } },
    actions: {
      "test.seed": defineAction({
        input: { type: "object" },
        run: async (ctx, input: { messages: Seed[] }) => {
          const db = ctx.as().db;
          const { insertedId: thread } = await db.collection("thread").insertOne({
            agents: ["booker"],
            at: input.messages[0].at,
          });
          for (const m of input.messages) {
            await db.collection("message").insertOne({ thread, to: [], text: "", ...m });
          }
          return thread;
        },
      }),
      "test.legacy": defineAction({
        input: { type: "object", properties: { thread: { type: "string" } } },
        run: async (ctx, input) => {
          // Lines as an outline kept them before they said when: [level, index, bytes].
          const outlines = ctx.as().db.collection<{ lines: unknown[][] }>("outline");
          const outline = await outlines.findOne({ _id: input.thread });
          await outlines.updateOne({ _id: input.thread }, {
            $set: { lines: outline!.lines.map((line) => line.slice(0, 3)) },
          });
        },
      }),
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...(options.history ? [history] : []), app],
  });
  const seed = async (messages: Seed[]) => {
    const thread = await runtime.call<string>("test.seed", { messages });
    await runtime.idle();
    return thread;
  };
  const say = async (thread: string, words: string) => {
    await runtime.call("chat.send", { thread, text: words, from: "ana" });
    await runtime.idle();
  };
  const prompt = (thread: string, agent: string) =>
    runtime.query<Prompt>("thread.prompt", { thread, agent });
  return { runtime, sent, seed, say, prompt };
}

/** Yesterday's conversation and one an hour ago, each a question and its answer. */
const yesterday: Seed[] = [
  { from: "ana", to: ["booker"], text: "book me for monday", at: ago(26 * HOUR) },
  { from: "booker", to: ["ana"], text: "booked monday", at: ago(26 * HOUR - 60_000) },
];
const earlier: Seed[] = [
  { from: "ana", to: ["booker"], text: "and a table for two?", at: ago(HOUR) },
  { from: "booker", to: ["ana"], text: "table booked", at: ago(HOUR - 60_000) },
];

test("the window by age starts on a grid: never older than maxAge, and still between steps", () => {
  const maxAge = 4 * HOUR;
  const step = maxAge / 10;
  for (const now of [Date.UTC(2026, 10, 3, 12), Date.UTC(2026, 10, 3, 12, 7, 13, 5)]) {
    const start = Date.parse(ageStart(new Date(now).toISOString(), maxAge));
    assert(start >= now - maxAge, "nothing older than maxAge");
    assert(start <= now - maxAge + step, "everything younger than nine tenths of it");
    assertEquals(start % step, 0, "on the grid");
  }
  // Within a step, the start holds: each prompt starts as the last one did.
  const at = (minutes: number) =>
    ageStart(new Date(Date.UTC(2026, 10, 3, 12, minutes)).toISOString(), maxAge);
  assertEquals(at(1), at(24));
  assert(at(25) > at(24), "and moves at the next");
});

for (const summarized of [false, true]) {
  const name = summarized ? "with history" : "without history";

  test(`${name}: what's older than an agent's maxAge isn't sent; newer is, and stays in the chat`, async () => {
    const { runtime, sent, seed, say } = await start({ history: summarized });
    try {
      const thread = await seed([...yesterday, ...earlier]);
      await say(thread, "what did I book?");
      const seen = said(sent.booker.at(-1)!);
      assert(!seen.includes("monday"), seen);
      assertStringIncludes(seen, "ana: and a table for two?");
      assertStringIncludes(seen, "table booked");
      assertStringIncludes(seen, "ana: what did I book?");
      // An agent without maxAge sees it all; the chat keeps it all.
      await say(thread, "@plain and you?");
      assertStringIncludes(said(sent.plain.at(-1)!), "ana → booker: book me for monday");
      const kept = await runtime.query<Message[]>("message.history", { thread });
      assertEquals(kept.filter((m) => m.text?.includes("monday")).length, 2);
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: only what's old goes: nothing in a window that holds it all`, async () => {
    const { runtime, sent, seed, say } = await start({ history: summarized });
    try {
      const thread = await seed(earlier);
      await say(thread, "what did I book?");
      assertEquals(sent.booker.at(-1)!.map(text), [
        "ana: and a table for two?",
        "table booked",
        "ana: what did I book?",
      ]);
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: what it was told in a message that aged out is told again`, async () => {
    const { runtime, sent, seed, say } = await start({ history: summarized, rules: true });
    try {
      const told = [{ name: "rules", text: RULES }];
      const old = await seed([yesterday[0], { ...yesterday[1], told }]);
      await say(old, "hello again");
      assertEquals(text(sent.booker.at(-1)!.at(-1)!), RULES, "out of its window: told again");
      const recent = await seed([earlier[0], { ...earlier[1], told }]);
      await say(recent, "hello again");
      assertEquals(text(sent.booker.at(-1)!.at(-1)!), "ana: hello again", "still in it: not again");
    } finally {
      await runtime.close();
    }
  });
}

/** Long messages, so each gets a line as it leaves the tail. */
const long = (n: number, at: string): Seed => ({
  from: "ana",
  to: ["booker"],
  text: `message number ${n} is long enough to need a summary line`,
  at,
});

test("with history: summary lines of messages older than the window aren't sent either", async () => {
  const { runtime, sent, seed, say, prompt } = await start({ history: true });
  try {
    // Six from yesterday and six from the last hour: the oldest nine or so become lines.
    const thread = await seed([
      ...Array.from({ length: 6 }, (_, n) => long(n, ago(26 * HOUR - n * 60_000))),
      ...Array.from({ length: 6 }, (_, n) => long(n + 6, ago(HOUR - n * 60_000))),
    ]);
    await say(thread, "what now?");
    const [outline] = sent.booker.at(-1)!;
    assertStringIncludes(text(outline), "Earlier in this conversation, summarized");
    const lines = text(outline).split("\n").filter((line) => /^\d+\+\d+\|/.test(line));
    assert(lines.length > 0, "the last hour's lines are sent");
    assert(lines.every((line) => Number(line.split("+")[0]) >= 6), lines.join(" / "));
    // The agent without maxAge gets every line.
    const all = text((await prompt(thread, "plain")).history[0]);
    assertStringIncludes(all, "0+1|S0");

    // Lines kept before they said when count as old: they go, the newer ones stay.
    await runtime.call("test.legacy", { thread });
    const legacy = (await prompt(thread, "booker")).history;
    assert(!said(legacy).includes("summarized"), said(legacy));
    assertStringIncludes(said(legacy), "ana: what now?");
  } finally {
    await runtime.close();
  }
});

test("with history: when every line is older than the window, no summary is sent", async () => {
  const { runtime, sent, seed, say } = await start({ history: true });
  try {
    const thread = await seed(
      Array.from({ length: 10 }, (_, n) => long(n, ago(26 * HOUR - n * 60_000))),
    );
    await say(thread, "hello again");
    assertEquals(sent.booker.at(-1)!.map(text), ["ana: hello again"]);
  } finally {
    await runtime.close();
  }
});

test("a maxAge that isn't a number of ms is refused at start", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: {
        booker: { instructions: "Book.", model: "script/main", history: { maxAge: "4h" } },
      },
    },
    adapters: { llm: { script: { async *generate() {} } } },
  });
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: [models, chat, app] }),
    Error,
    'Agent "booker": history.maxAge is in ms',
  );
});
