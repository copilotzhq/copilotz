/**
 * Memories live where they were learned. What Ana's agent learned in
 * Finance doesn't come up in Launch, by itself or recalled: working in
 * Launch, it reaches Launch and what Launch draws on, never Ana's other
 * spaces. In Ana's Personal space, which only she sees, it's told where
 * else it can read for her, and recalling from Finance there labels the
 * answer. Once Launch draws on Finance, recalling it there is Launch's own.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message, type Prompt } from "../../agents/chat/mod.ts";
import { memory } from "../../agents/memory/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** "remember x" remembers it; "recall x [in space]" recalls it and answers with it. */
const scripted: LlmAdapter = {
  async *generate({ messages }) {
    // What was said last, past what contexts add each turn.
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return yield { type: "text", text: `Recalled: ${said}` };
    const what = /(remember|recall) (.+?)(?: in (\w+))?$/.exec(said);
    if (what?.[1] === "remember") {
      return yield {
        type: "tool_call",
        call: { id: "m", name: "remember", input: { text: what[2], about: "ana" } },
      };
    }
    if (what?.[1] === "recall") {
      return yield {
        type: "tool_call",
        call: {
          id: "r",
          name: "recall",
          input: { query: what[2], ...(what[3] ? { in: what[3] } : {}) },
        },
      };
    }
    yield { type: "text", text: "ok" };
  },
};

test("a memory stays where it was learned; recalled from there, the answer carries it", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: { labels: true }, memory: {} },
      memory: { embedder: "hash/words" },
      provider: { s: { adapter: "s" } },
      agents: { lead: { instructions: "Hi.", model: "s/lead", default: true } },
    },
    adapters: { llm: { s: scripted } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, memory, ...access, app],
  });
  try {
    const say = async (actor: Actor, text: string, where: { in?: string; thread?: string }) => {
      const sent = await runtime.call<{ thread: string }>("chat.send", { text, ...where }, {
        actor,
      });
      await runtime.idle();
      return sent.thread;
    };
    await runtime.call("space.create", { id: "finance", name: "Finance" }, { actor: ana });
    await runtime.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
    await join(runtime, "launch", bob, "viewer", ana);
    await say(ana, "remember the budget is 10k", { in: "finance" });
    // A space's memories (its Memories tab): what was learned there, for those who reach it.
    type Listed = { text: string; in?: string };
    const listed = async (actor: Actor, where?: string) =>
      (await runtime.query<Listed[]>("memory.list", where ? { in: where } : {}, { actor }))
        .map((m) => m.text);
    assertEquals(await listed(ana, "finance"), ["the budget is 10k"]);
    assertEquals(await listed(ana, "launch"), []);
    assertEquals(await listed(ana), ["the budget is 10k"]);
    assertEquals(await listed(bob, "finance"), []);
    const launch = await say(ana, "hello", { in: "launch" });

    // Not in Launch's prompt, by itself or as somewhere else to look: it works in Launch.
    const promptFor = (person: Actor, where: string) =>
      runtime.query<Prompt>("thread.prompt", { thread: launch, agent: "lead" }, {
        actor: { kind: "agent", id: "lead", for: person, in: where },
      });
    const prompt = await promptFor(ana, "launch");
    assert(!JSON.stringify(prompt).includes("10k"), JSON.stringify(prompt.system));
    assert(!JSON.stringify(prompt).includes("Finance"), JSON.stringify(prompt.turn));

    // Recalled in Launch, it searches Launch; asked to look in Finance, it can't: nothing either.
    const texts = async (actor: Actor, thread = launch) =>
      (await runtime.query<Message[]>("message.history", { thread }, { actor }))
        .filter((m) => !m.private).map((m) => m.text);
    await say(ana, "recall budget", { thread: launch });
    await say(ana, "recall budget in finance", { thread: launch });
    const nothing = "Recalled: Nothing remembered about that.";
    const asked = ["hello", "ok", "recall budget", nothing, "recall budget in finance", nothing];
    assertEquals(await texts(ana), asked);
    assertEquals(await texts(bob), asked);

    // In Ana's Personal space, only she sees what's said: Finance is somewhere else to look, and
    // recalled from there, the answer carries it.
    const { space: personal } = await runtime.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const mine = await say(ana, "hello", { in: personal });
    const told = await runtime.query<Prompt>("thread.prompt", { thread: mine, agent: "lead" }, {
      actor: { kind: "agent", id: "lead", for: ana, in: personal },
    });
    assert(!told.system.join().includes("finance"), "the list stays out of the cached text");
    assert(
      told.turn.map((c) => c.text).join().includes("- Finance [in: finance]"),
      JSON.stringify(told.turn),
    );
    await say(ana, "recall budget in finance", { thread: mine });
    const hers = await texts(ana, mine);
    assert(hers.some((text) => text?.includes("budget is 10k")), JSON.stringify(hers));
    const answer = (await runtime.query<Message[]>("message.history", { thread: mine }, {
      actor: ana,
    })).findLast((m) => m.text?.includes("budget is 10k"));
    assertEquals(answer?.sources, ["finance"]);

    // Once Launch draws on Finance, it's Launch's to look in: found there, for everyone there.
    await runtime.call("member.set", {
      space: "finance",
      member: { kind: "space", id: "launch" },
      role: "viewer",
    }, { actor: ana });
    await say(ana, "recall budget in finance", { thread: launch });
    const now = await texts(bob);
    assert(now.at(-1)?.includes("budget is 10k"), JSON.stringify(now));
  } finally {
    await runtime.close();
  }
});
