/**
 * Memory across conversations: agents remember (updating what they already
 * knew), core memories are always in mind, relevant ones come up on their
 * own (for what the conversation is about, saying where they were learned),
 * recall searches by meaning and words and opens where a memory was learned,
 * forget hides, and an extractor writes memories down every few messages or
 * once a conversation is quiet. Embeddings are the offline `hash` adapter
 * (word overlap), so similarity is predictable.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  type Actor,
  type Clock,
  createRuntime,
  definePlugin,
  manualClock,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, type Prompt } from "../chat/mod.ts";
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
async function start(
  make: () => Store | Promise<Store>,
  embedder = "hash/words",
  o: { clock?: Clock; quiet?: number } = {},
) {
  const tools: string[] = [];
  const extractor: string[] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      // What was said last: the turn's context blocks come after it.
      const said = messages.filter((m) => !text(m).startsWith("<context"));
      const last = text(said.at(-1)!);
      if (connection.model === "cheap") {
        extractor.push(last);
        // Her own words, or said of her where its agents work for her.
        const city = last.match(/ana[^:]*: I live in (\w+)/) ??
          (last.includes("The agents here work for ana.")
            ? last.match(/she lives in (\w+)/)
            : null);
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
      else if ((m = last.match(/source (\S+)$/))) yield call("recall", { source: m[1] });
      else if ((m = last.match(/forget (\S+)$/))) yield call("forget", { id: m[1] });
      else yield { type: "text", text: "ok" };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" }, down: { adapter: "down" } },
      agents: { agent: { instructions: "Help.", model: "script/main" } },
      memory: {
        embedder,
        extractor: "script/cheap",
        every: 4,
        ...(o.quiet !== undefined ? { quiet: o.quiet } : {}),
      },
    },
    adapters: {
      llm: { script },
      // An embedding provider that refuses every call (a revoked key).
      embeddings: {
        down: { embed: () => Promise.reject(new Error("401 Unauthorized")) },
      },
    },
  });
  const runtime = await createRuntime({
    store: await make(),
    plugins: [models, chat, memory, memoryExtraction, app],
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const say = async (words: string, thread?: string, from = "ana", actor?: Actor) => {
    const sent = await runtime.call<{ thread: string }>(
      "chat.send",
      { thread, text: words, from },
      actor ? { actor } : undefined,
    );
    await runtime.idle();
    return sent.thread;
  };
  const prompt = (thread: string, actor?: Actor) =>
    runtime.query<Prompt>("thread.prompt", { thread, agent: "agent" }, actor ? { actor } : {});
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
  // as instructions (not data), the same in every conversation (so cached across them).
  const other = await say("hello again");
  const p = await prompt(other);
  assert(p.system.some((s) => s.startsWith("You remember across conversations.")));
  assert(!p.system.join("\n").includes('<context name="memory">'));
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
  "a failing recall goes on without memories; a failing remember is the agent's to see",
  async (make) => {
    const errors: unknown[][] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const { runtime, tools, say, prompt } = await start(make, "down/words");
      // The turn answers, with nothing recalled; the failure is logged.
      const thread = await say("what is my dog called?");
      const answers = await runtime.query<Message[]>("message.history", { thread });
      assertEquals(answers.at(-1)?.text, "ok");
      const p = await prompt(thread);
      assert(!toldIn(p).includes("Memories that may be relevant"));
      assert(errors.some((e) => String(e[0]).startsWith("memory: recall failed")));
      assert(errors.some((e) => String(e[1]).includes("401")));
      // remember is a tool: its failure is the agent's to see.
      await say("remember Ana's dog is called Rex", thread);
      assertStringIncludes(tools.at(-1)!, "401 Unauthorized");
      await runtime.close();
    } finally {
      console.error = log;
    }
  },
);

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

each(
  "what comes up on its own is for what the conversation is about, and says where it was learned",
  async (make) => {
    const { runtime, say, prompt } = await start(make);
    const asked = await say("what is my dog called?");
    // Learned elsewhere meanwhile; then a reply that names nothing.
    await say("remember Ana's dog is called Rex");
    await say("see above", asked);
    const told = toldIn(await prompt(asked));
    assertMatch(
      told,
      /- Ana's dog is called Rex \[m\w+\] \(learned \d{4}-\d{2}-\d{2}\)/,
    );
    // Told already, and still there whole: what comes up next is only what's new.
    await say("remember Ana's dog is called Rex and is 3 years old");
    await say("how old is the dog called Rex?", asked);
    const again = toldIn(await prompt(asked));
    assertEquals(again.split("- Ana's dog is called Rex [").length - 1, 1, again);
    assertStringIncludes(again, "- Ana's dog is called Rex and is 3 years old [");
    // A reply alone, in a conversation about nothing it knows, brings nothing up.
    const other = await say("see above");
    assert(!toldIn(await prompt(other)).includes("Rex"));
    await runtime.close();
  },
);

each("recall says where each memory was learned, and opens it", async (make) => {
  const { runtime, tools, say } = await start(make);
  const learned = await say("remember Ana's dog is called Rex");
  const id = tools.at(-1)!.slice(12, -2);
  await say("recall dog called", learned);
  assertMatch(tools.at(-1)!, /Rex \[m\w+\] \(learned here \d{4}-\d{2}-\d{2}\)$/);
  const other = await say("recall dog called");
  assertMatch(tools.at(-1)!, /Rex \[m\w+\] \(learned \d{4}-\d{2}-\d{2}\)$/);
  await say(`source ${id}`, other);
  const opened = tools.at(-1)!;
  assertStringIncludes(opened, `Where [${id}] was learned, conversation ${learned}`);
  assertStringIncludes(opened, "→ ana: remember Ana's dog is called Rex");
  assertStringIncludes(opened, "- agent: done");
  await say("source m000000", other);
  assertEquals(tools.at(-1), "No memory m000000 that you can read.");
  await runtime.close();
});

each("a quiet conversation is read for memories without waiting for more", async (make) => {
  const clock = manualClock(Date.now());
  const { runtime, extractor, say, memories } = await start(make, "hash/words", {
    clock,
    quiet: 60_000,
  });
  await say("I live in Lisbon");
  assertEquals(extractor.length, 0, "2 of 4 messages");
  clock.advance(61_000);
  await runtime.idle();
  assertEquals(extractor.length, 1, "quiet: read");
  assertEquals((await memories()).map((m) => m.text), ["Ana lives in Lisbon."]);
  // Nothing new since: quiet again reads nothing.
  clock.advance(61_000);
  await runtime.idle();
  assertEquals(extractor.length, 1);
  await runtime.close();
});
