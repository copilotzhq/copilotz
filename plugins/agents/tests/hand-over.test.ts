/**
 * Work handed to another space carries what the sender's work may read
 * there, for that space's people to see: so it's a share, asked of the
 * person it's done for as any other (yes this once, for this conversation,
 * for the routine that set it going, or no), unless everyone there could
 * see all that work may read anyway (a space drawing on where it comes
 * from). The same goes for saying something in another space's chat.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { type Approval, chat, type Message } from "../chat/mod.ts";
import { routines } from "../routines/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** North: "hand <space>: <what>" hands it over, "tell <chat>: <what>" says it there; Scout answers. */
const script: LlmAdapter = {
  async *generate({ messages, connection }) {
    const agent = connection.model;
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const hand = agent === "north" && heard.match(/(hand|tell) (\S+): (.+)$/s);
    if (hand) {
      const where = hand[1] === "hand" ? { space: hand[2] } : { thread: hand[2], to: "scout" };
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: "send_message", input: { ...where, text: hand[3] } },
      };
    } else yield { type: "text", text: `${agent} heard: ${heard.slice(-60)}` };
  },
};

const app = definePlugin({
  name: "app",
  adapters: { llm: { s: script } },
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
  say(said: string, where: { in?: string; thread?: string }): Promise<string>;
  answer(approval: Approval, answer: string): Promise<void>;
  chats(space: string): Promise<string[]>;
};

/** Ana's Personal space, where North works; Launch, Ana's and Bob's, where Scout answers. */
async function setup(fn: (s: Setup) => Promise<void>) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, routines, app],
  });
  try {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
    await join(rt, "launch", bob, "editor", ana);
    await rt.call("member.set", {
      space: "launch",
      member: { kind: "agent", id: "scout" },
      role: "editor",
    }, { actor: ana });
    await rt.call("member.remove", {
      space: "launch",
      member: { kind: "agent", id: "north" },
    }, { actor: ana });
    await fn({
      rt,
      personal,
      pending: () => rt.query<Approval[]>("approval.pending", {}, { actor: ana }),
      say: async (said, where) => {
        const { thread } = await rt.call<{ thread: string }>("chat.send", {
          text: said,
          ...where,
        }, { actor: ana });
        await rt.idle();
        return thread;
      },
      answer: async (approval, answer) => {
        await rt.call("chat.approve", { approval: approval._id, answer }, { actor: ana });
        await rt.idle();
      },
      // What each of a space's chats opened with.
      chats: async (space) => {
        const threads = await rt.query<{ _id: string }[]>("thread.recent", { in: space }, {
          actor: ana,
        });
        const firsts = await Promise.all(
          threads.map(async (t) =>
            (await rt.query<Message[]>("message.history", { thread: t._id }, { actor: ana }))
              .find((m) => !m.private)?.text ?? ""
          ),
        );
        return firsts.sort();
      },
    });
  } finally {
    await rt.close();
  }
}

test("from Personal into Launch, a hand-over asks Ana first, and nothing goes until she says", async () => {
  await setup(async (s) => {
    const thread = await s.say("hand launch: our plan for Friday", { in: s.personal });
    const [asked] = await s.pending();
    assertEquals(
      [asked.work, asked.on, asked.name, asked.people, asked.answers, asked.preview],
      ["share", "launch", "Launch", 2, ["once", "thread", "deny"], "our plan for Friday"],
    );
    const question = (await s.rt.query<Message[]>("message.history", { thread }, { actor: ana }))
      .find((m) => m._id === asked.question)!;
    assertEquals(question.text, "May I post this to Launch? Its 2 members will see it.");
    assertEquals(await s.chats("launch"), []);
  });
});

test("yes, this once: it's handed over and answered, and the next hand-over asks again", async () => {
  await setup(async (s) => {
    const thread = await s.say("hand launch: our plan for Friday", { in: s.personal });
    await s.answer((await s.pending())[0], "once");
    assertEquals(await s.chats("launch"), ["our plan for Friday"]);
    // Scout's answer came back to Personal without asking: only Ana reads it there.
    assertEquals(await s.pending(), []);
    const here = await s.rt.query<Message[]>("message.history", { thread }, { actor: ana });
    assert(here.some((m) => m.from === "scout" && m.text?.includes("scout heard")));
    assertStringIncludes(here.at(-1)!.text!, "north heard");

    // Used up: the same conversation's next hand-over asks again.
    await s.say("hand launch: and Monday", { thread });
    assertEquals((await s.pending()).map((a) => a.preview), ["and Monday"]);
    assertEquals(await s.chats("launch"), ["our plan for Friday"]);
  });
});

test("yes, for this conversation: its next hand-overs go; another conversation's ask", async () => {
  await setup(async (s) => {
    const thread = await s.say("hand launch: one", { in: s.personal });
    await s.answer((await s.pending())[0], "thread");
    await s.say("hand launch: two", { thread });
    assertEquals(await s.pending(), []);
    assertEquals(await s.chats("launch"), ["one", "two"]);
    await s.say("hand launch: three", { in: s.personal });
    assertEquals((await s.pending()).map((a) => a.preview), ["three"]);
  });
});

test("no: nothing is handed over, and North is told", async () => {
  await setup(async (s) => {
    const thread = await s.say("hand launch: our plan", { in: s.personal });
    await s.answer((await s.pending())[0], "deny");
    assertEquals(await s.chats("launch"), []);
    const said = await s.rt.query<Message[]>("message.history", { thread }, { actor: ana });
    assertStringIncludes(said.at(-1)!.text!, "No: ana said no to post this to Launch");
  });
});

test("saying something in another space's chat asks the same way", async () => {
  await setup(async (s) => {
    const theirs = await s.say("@scout kickoff", { in: "launch" });
    const thread = await s.say(`tell ${theirs}: our plan`, { in: s.personal });
    const [asked] = await s.pending();
    assertEquals([asked.on, asked.name, asked.preview], ["launch", "Launch", "our plan"]);
    const there = () =>
      s.rt.query<Message[]>("message.history", { thread: theirs }, { actor: ana });
    assert(!(await there()).some((m) => m.text === "our plan"));
    await s.answer(asked, "once");
    assert((await there()).some((m) => m.from === "north" && m.text === "our plan"));
    const back = await s.rt.query<Message[]>("message.history", { thread }, { actor: ana });
    assert(back.some((m) => m.from === "scout" && m.text?.includes("our plan")));
  });
});

test("where its people could see all the work may read, a hand-over goes without asking", async () => {
  await setup(async (s) => {
    // Ops draws on Launch: its people read Launch. North, in Launch, hands work to Ops.
    await s.rt.call("space.create", { id: "ops", name: "Ops" }, { actor: ana });
    await s.rt.call("member.set", {
      space: "launch",
      member: { kind: "space", id: "ops" },
      role: "viewer",
    }, { actor: ana });
    await s.rt.call("member.set", {
      space: "launch",
      member: { kind: "agent", id: "north" },
      role: "editor",
    }, { actor: ana });
    await s.say("@north hand ops: the rota", { in: "launch" });
    assert(!(await s.pending()).some((a) => a.work === "share"));
    assertEquals(await s.chats("ops"), ["the rota"]);
  });
});

test("a routine's standing yes covers its runs' hand-overs; not what Ana asks herself", async () => {
  await setup(async (s) => {
    const { routine } = await s.rt.call<{ routine: string }>("routine.create", {
      agent: "north",
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      post: "new",
      in: s.personal,
      name: "Daily",
      text: "hand launch: the daily note",
    }, { actor: ana });
    await s.rt.call("routine.run", { routine }, { actor: ana });
    await s.rt.idle();
    const [asked] = await s.pending();
    assertEquals(asked.answers, ["once", "thread", "origin", "deny"]);
    await s.answer(asked, "origin");
    assertEquals(await s.chats("launch"), ["the daily note"]);

    await s.rt.call("routine.run", { routine }, { actor: ana });
    await s.rt.idle();
    assertEquals(await s.pending(), []);
    assertEquals(await s.chats("launch"), ["the daily note", "the daily note"]);

    await s.say("hand launch: by hand", { in: s.personal });
    assertEquals((await s.pending()).map((a) => a.preview), ["by hand"]);
  });
});
