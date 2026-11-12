/**
 * An answer to work handed to another space goes back where it came from
 * without asking when everyone there could see all that work may read (from
 * someone's own Personal space they always could; a space drawing on the
 * other one, too). Otherwise whoever handed it over says where it goes:
 * posted there, or sent to them alone, in their Personal space; either
 * way the agent waiting there goes on.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { type Approval, chat, type Message, type Thread } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";
import { yesToShares } from "./yes.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** "hand <space>: <what>" hands work over; anything else, it says what it heard last. */
const script: LlmAdapter = {
  async *generate({ messages, connection }) {
    const agent = connection.model;
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const hand = heard.match(/hand (\S+): (.+)$/s);
    if (agent === "north" && hand) {
      yield {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "send_message",
          input: { space: hand[1], text: hand[2] },
        },
      };
    } else yield { type: "text", text: `${agent} heard: ${heard.slice(-80)}` };
  },
};

const app = definePlugin({
  name: "app",
  adapters: { llm: { s: script } },
  // A conversation as it's kept, for the test to look at (the system's).
  actions: {
    "test.thread": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, input) => ctx.db.collection<Thread>("thread").findOne({ _id: input.id }),
    }),
  },
  resources: {
    shared: { thread: {}, message: {} },
    provider: { s: { adapter: "s" } },
    agents: {
      north: { instructions: "n", model: "s/north", default: true, tools: ["send_message"] },
      scout: { instructions: "s", model: "s/scout" },
    },
  },
});

type Setup = {
  rt: Runtime;
  personal: string;
  pending(): Promise<Approval[]>;
  history(thread: string): Promise<Message[]>;
  ask(said: string, where: string): Promise<string>;
  answer(approval: Approval, answer: string): Promise<void>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, chat, ...access, app] });
  try {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    // Launch: Ana's and Bob's, where North works. Research: Ana's, where Scout answers.
    await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
    await join(rt, "launch", bob, "editor", ana);
    await rt.call("space.create", { id: "research", name: "Research" }, { actor: ana });
    await rt.call("member.set", {
      space: "research",
      member: { kind: "agent", id: "scout" },
      role: "editor",
    }, { actor: ana });
    await rt.call("member.remove", {
      space: "research",
      member: { kind: "agent", id: "north" },
    }, { actor: ana });
    await fn({
      rt,
      personal,
      pending: () => rt.query<Approval[]>("approval.pending", {}, { actor: ana }),
      history: (thread) => rt.query<Message[]>("message.history", { thread }, { actor: ana }),
      ask: async (said, where) => {
        const { thread } = await rt.call<{ thread: string }>("chat.send", {
          text: said,
          in: where,
        }, { actor: ana });
        await rt.idle();
        // Handing it over asks first too (its people can't all see what the work may read).
        await yesToShares(rt, ana);
        return thread;
      },
      answer: async (approval, answer) => {
        await rt.call("chat.approve", { approval: approval._id, answer }, { actor: ana });
        await rt.idle();
      },
    });
  } finally {
    await rt.close();
  }
}

/** What the agents said there, not their steps. */
const said = async (s: Setup, thread: string) =>
  (await s.history(thread)).filter((m) => !m.private).map((m) => [m.from, m.text ?? ""]);

test("from Launch, Scout's answer waits on Ana: Launch's people can't all see Research", async () => {
  await setup(async (s) => {
    const thread = await s.ask("hand research: what's new?", "launch");
    const [asked] = await s.pending();
    assertEquals([asked.work, asked.thread, asked.on, asked.name, asked.people, asked.answers], [
      "back",
      thread,
      "launch",
      "Launch",
      2,
      ["here", "me"],
    ]);
    assertStringIncludes(asked.preview!, "scout heard");
    // Nothing went back yet, and North still waits on it.
    assert(!(await said(s, thread)).some(([from]) => from === "scout"));
    assert(
      !(await said(s, thread)).some(([from, words]) => from === "north" && words.includes("heard")),
    );
    // Only these two answers.
    await assertRejects(
      () => s.rt.call("chat.approve", { approval: asked._id, answer: "once" }, { actor: ana }),
      Error,
      "This takes",
    );
  });
});

test("Post here: it goes back as it would have, and North goes on", async () => {
  await setup(async (s) => {
    const thread = await s.ask("hand research: what's new?", "launch");
    const [asked] = await s.pending();
    await s.answer(asked, "here");
    assertEquals(await s.pending(), []);
    const there = await said(s, thread);
    const back = there.find(([from]) => from === "scout")!;
    assertStringIncludes(back[1], "scout heard");
    // North read it, and answered Ana.
    const [, last] = there.at(-1)!;
    assertStringIncludes(last, "scout heard");
    assert(last.startsWith("north heard"));
  });
});

test("Send it to me only: Ana gets it in her Personal space; Launch hears where it went", async () => {
  await setup(async (s) => {
    const thread = await s.ask("hand research: what's new?", "launch");
    const [asked] = await s.pending();
    await s.answer(asked, "me");
    assertEquals(await s.pending(), []);
    const there = await said(s, thread);
    // In Launch: that it went to her, never what it says.
    assert(!there.some(([, words]) => words.includes("scout heard")), JSON.stringify(there));
    assert(
      there.some(([from, words]) => from === "scout" && words === "The answer went to ana only."),
    );
    assertStringIncludes(there.at(-1)![1], "The answer went to ana only.");
    assertEquals(there.at(-1)![0], "north");
    // In her Personal space: a conversation of its own, with the answer.
    const mine = `${asked.reply!.replace(/:reply$/, "")}:mine`;
    const chat = await s.rt.call<Thread | null>("test.thread", { id: mine });
    assertEquals(chat?.in, s.personal);
    const answer = (await s.history(mine)).find((m) => m.from === "scout")!;
    assertStringIncludes(answer.text!, "scout heard");
    assertEquals([answer.in, answer.to], [s.personal, ["ana"]]);
    // Bob, in Launch, never reads it.
    const his = await s.rt.query<Message[]>("message.history", { thread: mine }, { actor: bob })
      .catch(() => []);
    assertEquals(his, []);
  });
});

test("from Ana's Personal space, the answer comes back without asking", async () => {
  await setup(async (s) => {
    const thread = await s.ask("hand research: what's new?", s.personal);
    assertEquals(await s.pending(), []);
    const there = await said(s, thread);
    assert(there.some(([from, words]) => from === "scout" && words.includes("scout heard")));
    assertStringIncludes(there.at(-1)![1], "scout heard");
    assertEquals(there.at(-1)![0], "north");
  });
});

test("Launch drawing on Research: its people see what Research's work reads, so it's not asked", async () => {
  await setup(async (s) => {
    await s.rt.call("member.set", {
      space: "research",
      member: { kind: "space", id: "launch" },
      role: "viewer",
    }, { actor: ana });
    const thread = await s.ask("hand research: what's new?", "launch");
    assertEquals(await s.pending(), []);
    const there = await said(s, thread);
    assert(there.some(([from, words]) => from === "scout" && words.includes("scout heard")));
  });
});
