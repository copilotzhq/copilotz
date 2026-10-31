/**
 * Memory across conversations: agents remember (updating what they already
 * knew), core memories are always in mind, relevant ones come up on their
 * own, recall searches by meaning and words, forget hides, and an extractor
 * writes memories down every few messages. Embeddings are the offline `hash`
 * adapter (word overlap), so similarity is predictable.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Prompt } from "../chat/mod.ts";
import { type Memory, memory, memoryExtraction } from "../memory/mod.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `m_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/**
 * The agent acts on commands in the person's message: "remember[!] <text>"
 * (! for core), "about <who>: remember <text>", "recall <query>", "forget <id>".
 * The extractor turns "I live in <city>" into a core memory.
 */
async function start(make: () => Store | Promise<Store>) {
  const tools: string[] = [];
  const extractor: string[] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      // What was said last: the turn's context blocks come after it.
      const said = messages.filter((m) => !text(m).startsWith("<context"));
      const last = text(said.at(-1)!);
      if (connection.model === "cheap") {
        extractor.push(last);
        const city = last.match(/ana[^:]*: I live in (\w+)/);
        const memories = city
          ? [{ text: `Ana lives in ${city[1]}.`, about: "ana", core: true }]
          : [];
        yield { type: "text", text: JSON.stringify({ memories }) };
        return;
      }
      if (said.at(-1)!.role === "tool") {
        tools.push(last);
        yield { type: "text", text: "done" };
        return;
      }
      const call = (name: string, input: Record<string, unknown>) => ({
        type: "tool_call" as const,
        call: { id: crypto.randomUUID(), name, input },
      });
      let m: RegExpMatchArray | null;
      if ((m = last.match(/about (\w+): remember (.+)$/))) {
        yield call("remember", { text: m[2], about: m[1] });
      } else if ((m = last.match(/remember(!?) (.+)$/))) {
        yield call("remember", { text: m[2], ...(m[1] ? { core: true } : {}) });
      } else if ((m = last.match(/recall (.+)$/))) yield call("recall", { query: m[1] });
      else if ((m = last.match(/forget (\S+)$/))) yield call("forget", { id: m[1] });
      else yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      agents: { agent: { instructions: "Help.", model: "script/main" } },
      memory: { embedder: "hash/words", extractor: "script/cheap", every: 4 },
    },
    adapters: { llm: { script } },
  });
  const runtime = await createRuntime({
    store: await make(),
    plugins: [models, chat, memory, memoryExtraction, app],
  });
  const say = async (words: string, thread?: string, from = "ana") => {
    const sent = await runtime.call<{ thread: string }>("chat.send", { thread, text: words, from });
    await runtime.idle();
    return sent.thread;
  };
  const prompt = (thread: string) =>
    runtime.query<Prompt>("thread.prompt", { thread, agent: "agent" });
  const memories = () =>
    runtime.query<Memory[]>("memory.core", {
      agent: "agent",
      thread: "",
      people: ["ana", "bob"],
    });
  return { runtime, tools, extractor, say, prompt, memories };
}

each("remembering writes a memory about the person, and updates what it repeats", async (make) => {
  const { runtime, tools, say, prompt } = await start(make);
  const thread = await say("remember Ana prefers venues with a garden");
  assertMatch(tools.at(-1)!, /^Remembered \[m\w+\]\.$/);
  const id = tools.at(-1)!.slice(12, -2);
  // The same thing again, worded a little differently: updated, not repeated.
  await say("remember Ana prefers venues with gardens", thread);
  assertEquals(tools.at(-1), `Updated [${id}]; it said: "Ana prefers venues with a garden".`);
  // Every agent has the tools, without listing them.
  const p = await prompt(thread);
  assertEquals(p.tools.map((t) => t.name).sort(), ["forget", "recall", "remember"]);
  // Recall finds it by meaning and words.
  await say("recall where does Ana like venues", thread);
  assertStringIncludes(tools.at(-1)!, `Ana prefers venues with gardens [${id}]`);
  await runtime.close();
});

/** Everything an agent was told in a conversation (its contexts there), and what it would be now. */
const toldIn = (p: Prompt) =>
  [
    ...p.history.flatMap((m) => m.role === "user" && m.text.startsWith("<context") ? [m.text] : []),
    ...p.turn.map((c) => c.text),
  ].join("\n");

each("core memories are in mind in every conversation with the person", async (make) => {
  const { runtime, say, prompt } = await start(make);
  await say("remember! Ana is a landscape architect");
  // A different conversation with Ana: told when it begins. The system text says how to remember,
  // the same in every conversation (so cached across them).
  const other = await say("hello again");
  const p = await prompt(other);
  assertStringIncludes(p.system.join("\n"), '<context name="memory">');
  assert(!p.system.join("\n").includes("landscape"));
  assertStringIncludes(toldIn(p), '<context name="remembered">');
  assertStringIncludes(toldIn(p), "Ana is a landscape architect");
  // Not in a conversation without her.
  const bobs = await say("hi", undefined, "bob");
  assert(!toldIn(await prompt(bobs)).includes("landscape"));
  await runtime.close();
});

each("relevant memories come up on their own, in the turn after the conversation", async (make) => {
  const { runtime, say, prompt } = await start(make);
  await say("remember Ana's dog is called Rex");
  const thread = await say("what is my dog called?");
  // It came up after the question, and stays there.
  const p = await prompt(thread);
  const told = p.history.flatMap((m) =>
    m.role === "user" && m.text.startsWith('<context name="recall">') ? [m.text] : []
  );
  assertEquals(told.length, 1);
  assertStringIncludes(told[0], "Ana's dog is called Rex");
  assertEquals(p.turn, []);
  // Unrelated talk brings nothing up.
  const other = await say("the weather looks fine today");
  const q = await prompt(other);
  assertEquals(q.turn, []);
  assert(!q.history.some((m) => "text" in m && m.text?.includes('<context name="recall">')));
  await runtime.close();
});

each(
  "a core memory learned in a conversation leaves its system text as it began: it comes up there, and is in mind in the next",
  async (make) => {
    const { runtime, say, prompt } = await start(make);
    const thread = await say("hello");
    const system = (await prompt(thread)).system;
    await say("remember! Ana's dog is called Rex", thread);
    assertEquals((await prompt(thread)).system, system, "the cached system text stays");
    await say("what is my dog called?", thread);
    assert(
      (await prompt(thread)).history.some((m) =>
        m.role === "user" && m.text.startsWith('<context name="recall">') && m.text.includes("Rex")
      ),
    );
    const next = await say("hi again");
    assertStringIncludes(toldIn(await prompt(next)), "Ana's dog is called Rex");
    await runtime.close();
  },
);

each("forgetting hides a memory from recall and from every prompt", async (make) => {
  const { runtime, tools, say, prompt } = await start(make);
  const thread = await say("remember! Ana works on Saturdays");
  const id = tools.at(-1)!.slice(12, -2);
  await say(`forget ${id}`, thread);
  assertEquals(tools.at(-1), `Forgotten [${id}].`);
  await say("recall Ana Saturdays", thread);
  assertEquals(tools.at(-1), "Nothing remembered about that.");
  assert(!(await prompt(thread)).system.join("\n").includes("Saturdays"));
  await runtime.close();
});

each("memories about others stay with them; notes to self stay with the agent", async (make) => {
  const { runtime, tools, say } = await start(make);
  const thread = await say("about bob: remember Bob is allergic to nuts");
  assertMatch(tools.at(-1)!, /^Remembered/);
  await say("recall allergic nuts", thread);
  assertEquals(tools.at(-1), "Nothing remembered about that.", "Bob isn't in this conversation");
  const bobs = await say("recall allergic nuts", undefined, "bob");
  assertStringIncludes(tools.at(-1)!, "Bob is allergic to nuts");
  // A note to self goes wherever the agent goes.
  await say("about me: remember Double-check dates before booking", thread);
  await say("recall booking dates", bobs, "bob");
  assertStringIncludes(tools.at(-1)!, "Double-check dates before booking (about you)");
  await runtime.close();
});

each("the extractor writes down what's worth keeping, every few messages", async (make) => {
  const { runtime, extractor, say, memories } = await start(make);
  const thread = await say("I live in Porto");
  assertEquals(extractor.length, 0, "not yet: 2 of 4 messages");
  await say("nice weather", thread);
  assertEquals(extractor.length, 1);
  const kept = await memories();
  assertEquals(kept.map((m) => [m.text, m.about, m.by, m.core]), [
    ["Ana lives in Porto.", "person:ana", "memory", true],
  ]);
  // It knows what it knew: the next excerpt carries it as known.
  await say("I live in Porto", thread);
  await say("still", thread);
  assertStringIncludes(extractor.at(-1)!, "<known>\n- Ana lives in Porto.");
  assertEquals((await memories()).length, 1, "the same memory again is not repeated");
  await runtime.close();
});
