/**
 * Sharing beyond an agent's bound: its work reads only what both its
 * destination and its person reach, so a post somewhere whose people don't
 * all reach that (Ana's Personal agent posting in Launch, Shop's agent
 * writing into a customer's chat) asks its person first, as a computer's
 * command does, and the turn waits. Only yes this once, yes for this
 * conversation, or no; for a routine's run, yes for that routine too; never
 * always. On a yes the call runs again, and the post goes.
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
import { type Approval, chat, type Message, tool } from "../chat/mod.ts";
import { routines } from "../routines/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** "post <words> to <space>" (or "into <thread>") posts a note; told what came of it, it says so. */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      yield { type: "text", text: `tool said: ${text(last)}` };
      return;
    }
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const post = heard.match(/post (.+) (to|into) (\S+)$/);
    if (post) {
      const where = post[2] === "to" ? { in: post[3] } : { thread: post[3] };
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: "post", input: { text: post[1], ...where } },
      };
    } else yield { type: "text", text: "ok" };
  },
};

type Note = { _id: string; in: string; thread?: string; text: string };

const note = {
  type: "object",
  properties: { in: { type: "string" }, thread: { type: "string" }, text: { type: "string" } },
  required: ["in", "text"],
} as const;

const app = definePlugin({
  name: "app",
  // A note lives in a space; one in a chat is part of it, and goes where the chat goes.
  collections: { note: { schema: note } },
  resources: {
    shared: { thread: {}, message: {}, note: { part: "thread" } },
    provider: { s: { adapter: "s" } },
    tools: {
      // Writes a note as the agent: in a space, or into a chat (where that chat lives).
      post: tool({
        description: "Posts a note",
        input: {
          type: "object",
          properties: {
            in: { type: "string" },
            thread: { type: "string" },
            text: { type: "string" },
          },
          required: ["text"],
        },
        run: async (input, ctx) => {
          const chat = input.thread
            ? await ctx.as().db.collection<{ in: string }>("thread").findOne({ _id: input.thread })
            : null;
          const where = chat?.in ?? input.in ?? ctx.in!;
          await ctx.db.collection("note").insertOne({
            in: where,
            ...(input.thread ? { thread: input.thread } : {}),
            text: input.text,
          });
          return `posted in ${where}`;
        },
      }),
    },
    agents: {
      north: { instructions: "n", model: "s/north", default: true, tools: ["post"] },
    },
  },
  adapters: { llm: { s: script } },
});

type Setup = {
  rt: Runtime;
  personal: string;
  pending(actor?: Actor): Promise<Approval[]>;
  notes(space: string): Promise<string[]>;
  say(text: string, where: { in?: string; thread?: string }): Promise<string>;
  answer(approval: Approval, answer: string): Promise<void>;
  history(thread: string): Promise<Message[]>;
};

/** The notes in a space, as Ana reads them. */
const notesOf = (rt: Runtime) => async (space: string) =>
  (await rt.call<Note[]>("test.notes", { in: space }, { actor: ana })).map((n) => n.text).sort();

const reader = definePlugin({
  name: "reader",
  actions: {
    "test.notes": defineAction({
      input: { type: "object", properties: { in: { type: "string" } }, required: ["in"] },
      allow: () => true,
      run: (ctx, input) => ctx.db.collection<Note>("note").find({ in: input.in }),
    }),
  },
});

async function setup(fn: (s: Setup) => Promise<void>) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, routines, app, reader],
  });
  try {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
    await join(rt, "launch", bob, "editor", ana);
    await fn({
      rt,
      personal,
      pending: (actor = ana) => rt.query<Approval[]>("approval.pending", {}, { actor }),
      notes: notesOf(rt),
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
      history: (thread) => rt.query<Message[]>("message.history", { thread }, { actor: ana }),
    });
  } finally {
    await rt.close();
  }
}

/** What the agent said last in a conversation, to Ana. */
const lastSaid = async (s: Setup, thread: string) =>
  (await s.history(thread)).filter((m) => m.from === "north" && !m.private).at(-1)?.text ?? "";

test("a post beyond its work's bound asks its person, and the turn waits", async () => {
  await setup(async (s) => {
    const thread = await s.say("post hello team to launch", { in: s.personal });
    const [asked] = await s.pending();
    // Where, and to how many: no sentence (`text`), which views say in the reader's words.
    assertEquals(
      [asked.work, asked.on, asked.name, asked.people, asked.text, asked.answers, asked.preview],
      ["share", "launch", "Launch", 2, undefined, ["once", "thread", "deny"], "hello team"],
    );
    assert(asked.call && asked.question, "its call's own, with its question");
    assertEquals(await s.notes("launch"), []);
    const question = (await s.history(thread)).find((m) => m._id === asked.question)!;
    assertEquals([question.from, question.to], ["north", ["ana"]]);
    assertEquals(question.text, "May I post this to Launch? Its 2 members will see it.");
    // Nobody else is asked: Bob sees nothing waiting.
    assertEquals(await s.pending(bob), []);
  });
});

test("yes, this once: the post goes, and the next one asks again", async () => {
  await setup(async (s) => {
    const thread = await s.say("post hello team to launch", { in: s.personal });
    const [asked] = await s.pending();
    await s.answer(asked, "once");
    assertEquals(await s.notes("launch"), ["hello team"]);
    assertEquals(await s.pending(), []);
    const said = await s.history(thread);
    assert(said.some((m) => m.from === "ana" && m.text === "Yes, this once: Launch"));
    assertStringIncludes(await lastSaid(s, thread), "posted in launch");

    // Used up: the same conversation's next post asks again.
    await s.say("post second to launch", { thread });
    assertEquals(await s.notes("launch"), ["hello team"]);
    assertEquals((await s.pending()).map((a) => a.preview), ["second"]);
  });
});

test("yes, for this conversation: its next posts there go, another conversation's ask", async () => {
  await setup(async (s) => {
    const thread = await s.say("post one to launch", { in: s.personal });
    await s.answer((await s.pending())[0], "thread");
    await s.say("post two to launch", { thread });
    assertEquals(await s.notes("launch"), ["one", "two"]);
    assertEquals(await s.pending(), []);
    const said = await s.history(thread);
    assert(said.some((m) => m.from === "ana" && m.text === "Yes, for this conversation: Launch"));

    // Only this conversation: another one asks.
    await s.say("post three to launch", { in: s.personal });
    assertEquals(await s.notes("launch"), ["one", "two"]);
    assertEquals((await s.pending()).map((a) => a.preview), ["three"]);
  });
});

test("no: nothing goes, and the agent is told", async () => {
  await setup(async (s) => {
    const thread = await s.say("post hello to launch", { in: s.personal });
    await s.answer((await s.pending())[0], "deny");
    assertEquals(await s.notes("launch"), []);
    assertEquals(await s.pending(), []);
    assertStringIncludes(
      await lastSaid(s, thread),
      "No: ana said no to post this to Launch: Launch",
    );
  });
});

test("a share is never allowed always", async () => {
  await setup(async (s) => {
    await s.say("post hello to launch", { in: s.personal });
    const [asked] = await s.pending();
    assert(!asked.answers.includes("always"));
    await assertRejects(
      () => s.rt.call("chat.approve", { approval: asked._id, answer: "always" }, { actor: ana }),
      Error,
      "This takes",
    );
    assertEquals(await s.notes("launch"), []);
    assertEquals((await s.pending()).length, 1);
  });
});

test("where everyone reaches what the work may read, nothing is asked", async () => {
  await setup(async (s) => {
    // In Launch, North reads Launch alone: a post there goes as it is.
    await s.rt.call("member.set", {
      space: "launch",
      member: { kind: "agent", id: "north" },
      role: "editor",
    }, { actor: ana });
    await s.say("post in place to launch", { in: "launch" });
    // In Ana's own Personal space, only she sees it.
    await s.say(`post mine to ${s.personal}`, { in: s.personal });
    assertEquals(await s.pending(), []);
    assertEquals(await s.notes("launch"), ["in place"]);
    assertEquals(await s.notes(s.personal), ["mine"]);
  });
});

test("a routine's run can be let for that routine: its next runs post without asking", async () => {
  await setup(async (s) => {
    const { routine } = await s.rt.call<{ routine: string }>("routine.create", {
      agent: "north",
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      post: "new",
      in: s.personal,
      name: "Standup",
      text: "post daily note to launch",
    }, { actor: ana });
    await s.rt.call("routine.run", { routine }, { actor: ana });
    await s.rt.idle();
    const [asked] = await s.pending();
    assertEquals(asked.answers, ["once", "thread", "origin", "deny"]);
    assertEquals([asked.origin?.kind, asked.origin?.id], ["routine", routine]);
    await s.answer(asked, "origin");
    assertEquals(await s.notes("launch"), ["daily note"]);

    // Its next run, in a chat of its own, goes on its own.
    await s.rt.call("routine.run", { routine }, { actor: ana });
    await s.rt.idle();
    assertEquals(await s.pending(), []);
    assertEquals(await s.notes("launch"), ["daily note", "daily note"]);

    // Not what Ana asks North herself.
    await s.say("post by hand to launch", { in: s.personal });
    assertEquals((await s.pending()).map((a) => a.preview), ["by hand"]);
  });
});

test("into a customer's chat: it asks to send it to them, by name", async () => {
  await setup(async (s) => {
    await s.rt.call("space.create", { id: "shop", name: "Shop" }, { actor: ana });
    await s.rt.call("member.set", {
      space: "shop",
      member: { kind: "agent", id: "north" },
      role: "editor",
    }, { actor: ana });
    await s.rt.call("contact.start", {
      id: "c-maria-001",
      in: "shop",
      via: "whatsapp",
      name: "Maria",
    });
    const { thread: hers } = await s.rt.call<{ thread: string }>("contact.chat", {
      contact: "c-maria-001",
      in: "shop",
    });
    // Shop's agent, in a staff conversation, writes into her chat: she'd read what Shop's work may.
    const staff = await s.say(`post your order shipped into ${hers}`, { in: "shop" });
    const [asked] = await s.pending();
    assertEquals([asked.on, asked.name, asked.text], [`thread:${hers}`, "Maria", undefined]);
    const question = (await s.history(staff)).find((m) => m._id === asked.question)!;
    assertEquals(question.text, "May I send this to Maria?");
    assertEquals(await s.notes("shop"), []);
    await s.answer(asked, "once");
    assertEquals(await s.notes("shop"), ["your order shipped"]);
  });
});
