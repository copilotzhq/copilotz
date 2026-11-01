/**
 * An agent hands work to another space's agents: a real chat there, that its
 * members see, for the same person, who must be able to write there. The answer
 * comes back to the chat it came from, and the agent carries on from it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, tool } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What each agent's tool saw of who it works as, and what the send tool said. */
let seen: Record<string, Actor | undefined> = {};
let said: string[] = [];
let told: Record<string, string[]> = {};
/** Every model call, in order. */
let calls: { agent: string; messages: LlmMessage[] }[] = [];
/** Whether its work had been stopped by the time its tool ran. */
const stoppedBefore: Record<string, boolean> = {};
/** What an agent told to "hold" waits for before it goes on. */
let held: Promise<void> = Promise.resolve();

/** "hand <space> <to?>: <what>" delegates; "ask whoami" calls whoami; else it says what it heard. */
const script: LlmAdapter = {
  async *generate({ messages, connection, instructions }) {
    const agent = connection.model;
    (told[agent] ??= []).push(messages.map(text).join("\n") + instructions);
    calls.push({ agent, messages });
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      said.push(text(last));
      yield { type: "text", text: `${agent} done` };
      return;
    }
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    if (agent === "lead" && heard.includes("hold")) await held;
    const hand = heard.match(/hand (\S+) ?(\w*): (.+)$/s);
    if (hand) {
      yield {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "send_message",
          input: { space: hand[1], ...(hand[2] ? { to: hand[2] } : {}), text: hand[3] },
        },
      };
    } else if (heard.includes("whoami")) {
      yield { type: "tool_call", call: { id: crypto.randomUUID(), name: "whoami", input: {} } };
    } else yield { type: "text", text: `${agent} heard: ${heard.slice(-60)}` };
  },
};

const whoami = tool({
  description: "who",
  input: { type: "object", properties: {} },
  run: (_i, ctx) => {
    seen[ctx.agent] = ctx.actor;
    stoppedBefore[ctx.agent] = ctx.signal.aborted;
    return "noted";
  },
});

const app = definePlugin({
  name: "app",
  adapters: { llm: { s: script } },
  resources: {
    shared: { thread: {}, message: { labels: true } },
    provider: { s: { adapter: "s" } },
    tools: { whoami },
    agents: {
      north: {
        instructions: "n",
        model: "s/north",
        default: true,
        tools: ["send_message", "whoami"],
      },
      lead: { instructions: "l", model: "s/lead", tools: ["send_message", "whoami"] },
      dev: { instructions: "d", model: "s/dev", tools: ["whoami"] },
    },
  },
});

async function setup(fn: (rt: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>) {
  seen = {};
  said = [];
  told = {};
  calls = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
  });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

const team = async (
  rt: Awaited<ReturnType<typeof createRuntime>>,
  name: string,
  agent: string,
) => {
  const { space } = await rt.call<{ space: string }>("space.create", { name }, { actor: ana });
  await rt.call("member.set", { space, member: { kind: "agent", id: agent }, role: "editor" }, {
    actor: ana,
  });
  await rt.call("member.remove", { space, member: { kind: "agent", id: "north" } }, { actor: ana });
  return space;
};
const history = (
  rt: Awaited<ReturnType<typeof createRuntime>>,
  thread: string,
  actor: Actor = ana,
) => rt.query<Message[]>("message.history", { thread }, { actor });

test("work handed to another space opens a chat its members see, and its answer comes back", async () => {
  await setup(async (rt) => {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const pm = await team(rt, "Project", "lead");
    await join(rt, pm, bob, "editor", ana);
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: `hand ${pm}: please whoami`,
      in: personal,
    }, { actor: ana });
    await rt.idle();

    // A chat in that space, with whoever answers there, working for Ana, as itself.
    const chats = await rt.query<{ _id: string; title?: string; in: string }[]>("thread.recent", {
      in: pm,
    }, { actor: bob });
    assertEquals(chats.length, 1);
    const there = await history(rt, chats[0]._id, bob);
    const asked = there.find((m) => m.from === "north")!;
    assertEquals([asked.text, asked.to, asked.via?.kind], ["please whoami", ["lead"], "delegated"]);
    assertEquals([seen.lead?.kind, seen.lead?.id, (seen.lead?.for as Actor)?.id, seen.lead?.at], [
      "agent",
      "lead",
      "ana",
      pm,
    ]);
    assert(there.some((m) => m.from === "lead" && m.text === "lead done"));

    // Its answer is back in the chat it came from, and the agent carried on from it.
    const here = await history(rt, thread);
    const back = here.find((m) => m.from === "lead")!;
    assertEquals([back.text, back.to, back.in, back.via?.kind], [
      "lead done",
      ["north"],
      personal,
      "delegated",
    ]);
    assertEquals(back.via?.name, "Project");
    assert(here.at(-1)!.from === "north", "it answered after");
    assertEquals(here.at(-1)!.to, ["ana"]);
    // Bob never sees the chat it came from.
    assertEquals(await history(rt, thread, bob), []);
  });
});

test("a chain of hand-overs works, each for the same person", async () => {
  await setup(async (rt) => {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const pm = await team(rt, "Project", "lead");
    const dev = await team(rt, "Dev", "dev");
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: `hand ${pm}: hand ${dev}: whoami`,
      in: personal,
    }, { actor: ana });
    await rt.idle();
    assertEquals([seen.dev?.id, (seen.dev?.for as Actor)?.id, seen.dev?.at], ["dev", "ana", dev]);
    const here = await history(rt, thread);
    assert(here.some((m) => m.from === "lead" && m.via?.kind === "delegated"));
    assertEquals(here.at(-1)!.from, "north");
  });
});

test("only where its person may write, and to who answers there", async () => {
  await setup(async (rt) => {
    const { space: mine } = await rt.call<{ space: string }>("space.personal", {}, { actor: bob });
    const pm = await team(rt, "Project", "lead");
    const refused = async (message: string, actor = bob) => {
      said = [];
      await rt.call("chat.send", { text: message, in: mine }, { actor });
      await rt.idle();
      return said.at(-1) ?? "";
    };
    // Bob isn't in Project.
    assertStringIncludes(await refused(`hand ${pm}: hello`), "can't write");
    assertEquals(await rt.query("thread.recent", { in: pm }, { actor: ana }), []);
    await join(rt, pm, bob, "viewer", ana);
    assertStringIncludes(await refused(`hand ${pm}: hello`), "can't write");
    await rt.call("member.set", { space: pm, member: bob, role: "editor" }, { actor: ana });
    assertStringIncludes(await refused(`hand ${pm} dev: hello`), 'nobody called "dev"');
    // A space with nobody answering: nobody to hand to.
    const { space: empty } = await rt.call<{ space: string }>("space.create", { name: "Empty" }, {
      actor: bob,
    });
    await rt.call("member.remove", { space: empty, member: { kind: "agent", id: "north" } }, {
      actor: bob,
    });
    assertStringIncludes(await refused(`hand ${empty}: hello`), "no agent answers");
  });
});

test("an agent is told where it can hand work, and not where its person can't", async () => {
  await setup(async (rt) => {
    const { space: mine } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const pm = await team(rt, "Project", "lead");
    const { space: hers } = await rt.call<{ space: string }>("space.create", { name: "Hers" }, {
      actor: bob,
    });
    await rt.call("member.set", {
      space: hers,
      member: { kind: "agent", id: "lead" },
      role: "editor",
    }, {
      actor: bob,
    });
    await rt.call("chat.send", { text: "hello", in: mine }, { actor: ana });
    await rt.idle();
    const prompt = told.north.join("\n");
    assertStringIncludes(prompt, `Project [space: ${pm}]: lead`);
    assert(!prompt.includes("Hers"), "not a space of hers");
  });
});

test("what set the work going, and a key's limit, go with it", async () => {
  await setup(async (rt) => {
    const { space: one } = await rt.call<{ space: string }>("space.create", { name: "One" }, {
      actor: ana,
    });
    const pm = await team(rt, "Project", "lead");
    // A key for One can't hand work to Project.
    const key: Actor = { kind: "person", id: "ana", key: "k", within: one };
    said = [];
    await rt.call("chat.send", { text: `hand ${pm}: whoami`, in: one }, { actor: key });
    await rt.idle();
    assertStringIncludes(said.at(-1) ?? "", "can't write");
    assertEquals(seen.lead, undefined);

    // A routine's run hands over: the work there is still part of that run.
    const origin = { kind: "routine", id: "r1", name: "Daily", rev: 3 };
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    await rt.call("chat.send", { text: `hand ${pm}: whoami`, in: personal }, {
      actor: { ...ana, origin },
    });
    await rt.idle();
    assertEquals((seen.lead?.for as Actor)?.origin, origin);
  });
});

test("stopping a chat stops what it handed over", async () => {
  await setup(async (rt) => {
    let release = () => {};
    held = new Promise((resolve) => release = resolve);
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const pm = await team(rt, "Project", "lead");
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: `hand ${pm}: hold, then whoami`,
      in: personal,
    }, { actor: ana });
    for (let i = 0; i < 300 && !told.lead; i++) await new Promise((r) => setTimeout(r, 5));
    assert(told.lead, "it reached the other space");
    const { stopped } = await rt.call<{ stopped: number }>("chat.stop", { thread }, { actor: ana });
    assert(stopped >= 2, `stopped ${stopped}`);
    release();
    await rt.idle();
    // Scripted, it doesn't notice by itself; its work was told to stop.
    assertEquals(stoppedBefore.lead ?? true, true);
    const after = await history(rt, thread);
    assert(after.at(-1)!.stopped, "north's turn ended as stopped");
    held = Promise.resolve();
  });
});

test("the same agent in another space is other work, and reads it as input", async () => {
  await setup(async (rt) => {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    // North is who answers there: nobody else needs to be.
    const { space: solo } = await rt.call<{ space: string }>("space.create", { name: "Solo" }, {
      actor: ana,
    });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: `hand ${solo}: whoami`,
      in: personal,
    }, { actor: ana });
    await rt.idle();

    // It worked there, as itself, for Ana, with what it was handed as input.
    assertEquals([seen.north?.id, (seen.north?.for as Actor)?.id, seen.north?.at], [
      "north",
      "ana",
      solo,
    ]);
    const there = calls.find((c) =>
      c.messages.some((m) => text(m).includes('You (via delegated "Personal"): whoami'))
    );
    assert(there, "it read what it handed over");
    assertEquals(there.messages.at(-1)?.role, "user");
    assert(
      !there.messages.some((m) => m.role === "assistant" && text(m).includes("whoami")),
      "not as something it said",
    );

    // The answer came back, as input too, and it carried on, ending with Ana.
    const here = await history(rt, thread);
    const back = here.find((m) => m.via?.kind === "delegated")!;
    assertEquals([back.from, back.to, back.via?.name, back.text], [
      "north",
      ["north"],
      "Solo",
      "north done",
    ]);
    const resumed = calls.at(-1)!;
    const last = resumed.messages.at(-1)!;
    assertEquals(last.role, "user");
    assertStringIncludes(text(last), 'You (via delegated "Solo"): north done');
    assertEquals(here.at(-1)!.from, "north");
    assertEquals(here.at(-1)!.to, ["ana"]);
    assert(here.at(-1)!.text !== "north done", "its own answer, after what came back");
  });
});

test("whoever the space says answers takes it, even the agent that sent it", async () => {
  await setup(async (rt) => {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Both" }, {
      actor: ana,
    });
    await rt.call("member.set", { space, member: { kind: "agent", id: "lead" }, role: "editor" }, {
      actor: ana,
    });
    await rt.call("chat.send", { text: `hand ${space}: whoami`, in: personal }, { actor: ana });
    await rt.idle();
    assertEquals(seen.north?.at, space);
    assertEquals(seen.lead, undefined);

    // The context says so; and naming another still reaches them.
    assertStringIncludes(told.north.join("\n"), `north (you, working there)`);
    await rt.call("chat.send", { text: `hand ${space} lead: whoami`, in: personal }, {
      actor: ana,
    });
    await rt.idle();
    assertEquals(seen.lead?.at, space);
  });
});
