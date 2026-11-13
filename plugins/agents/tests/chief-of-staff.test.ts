/**
 * An agent in its person's Personal space works across their spaces, as they
 * can: it lists and reads the chats of another space, says something in one
 * (send_message's `thread`: who answers there gets it, and the answer comes
 * back), and keeps a routine there once its person says yes (Launch's people
 * would see what Personal's work may draw on). From a shared space it
 * reaches only that space, and says so. Sending to a chat needs its person to
 * be able to write there, wherever the agent is.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { type Approval, chat, type Message } from "../chat/mod.ts";
import { routines } from "../routines/mod.ts";
import type { Routine } from "../routines/collections/routine.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";
import { yesToShares } from "./yes.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What each tool call returned, by agent, in order. */
let got: Record<string, string[]> = {};

/**
 * "do <tool> <json>" calls that tool with that input; what it returns, the agent says
 * ("<agent> got: …"); anything else, it says it heard it.
 */
const script: LlmAdapter = {
  async *generate({ messages, connection }) {
    const agent = connection.model;
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      (got[agent] ??= []).push(text(last));
      yield { type: "text", text: `${agent} got: ${text(last).slice(0, 300)}` };
      return;
    }
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const call = heard.match(/do (\w+) (\{.*\})\s*$/s);
    if (call) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: call[1], input: JSON.parse(call[2]) },
      };
    } else yield { type: "text", text: `${agent} heard: ${heard.slice(-80)}` };
  },
};

const app = definePlugin({
  name: "app",
  adapters: { llm: { s: script } },
  resources: {
    shared: { thread: {}, message: { drew: true } },
    provider: { s: { adapter: "s" } },
    agents: {
      north: {
        instructions: "n",
        model: "s/north",
        default: true,
        tools: ["send_message", "list_conversations", "read_conversation", "schedule_routine"],
      },
      east: { instructions: "e", model: "s/east", tools: [] },
    },
  },
});

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    personal: string;
    launch: string;
    /** Launch's chat, where east answered ana. */
    there: string;
    say: (said: string, where: { in?: string; thread?: string }) => Promise<string>;
    history: (thread: string, actor?: Actor) => Promise<Message[]>;
  }) => Promise<void>,
) {
  got = {};
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, routines, app],
  });
  try {
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    // Launch: east answers there; north is a member too, as an app's core agents are.
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await rt.call("member.set", {
      space: launch,
      member: { kind: "agent", id: "east" },
      role: "editor",
    }, { actor: ana });
    const say = async (said: string, where: { in?: string; thread?: string }) => {
      // Without a chat or a space: a new chat in ana's Personal space.
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: said,
        ...(where.thread || where.in ? where : { in: personal }),
      }, { actor: ana });
      await rt.idle();
      // Saying something in another space's chat from Personal asks her first: she says yes.
      await yesToShares(rt, ana);
      return thread;
    };
    const there = await say("@east how's the launch going?", { in: launch });
    await fn({
      rt,
      personal,
      launch,
      there,
      say,
      history: (thread, actor = ana) =>
        rt.query<Message[]>("message.history", { thread }, { actor }),
    });
  } finally {
    await rt.close();
  }
}

test("from Personal, an agent lists and reads another space's chats, and says something in one", async () => {
  await setup(async ({ launch, there, say, history }) => {
    // Its chats, there: their ids, titles and latest.
    const here = await say(`do list_conversations {"in":"${launch}"}`, {});
    assertStringIncludes(got.north[0], `- ${there}`);
    assertStringIncludes(got.north[0], "how's the launch going?");
    assertStringIncludes(got.north[0], "east");
    // What was said there, without east's private steps.
    await say(`do read_conversation {"conversation":"${there}"}`, { thread: here });
    assertStringIncludes(got.north[1], "how's the launch going?");
    assertStringIncludes(got.north[1], "east heard:");

    // Saying something there: east answers there, and the answer comes back here.
    await say(
      `do send_message {"thread":"${there}","text":"Ana wants the launch date by Friday."}`,
      { thread: here },
    );
    // Its turn waited for the answer: what it read next was east's, not the tool's output.
    const launchSaid = await history(there);
    const sent = launchSaid.find((m) => m.from === "north" && m.text?.includes("by Friday"))!;
    assertEquals([sent.to, sent.in, sent.via?.name], [["east"], launch, "Personal"]);
    assert(launchSaid.some((m) => m.from === "east" && m.text?.includes("by Friday")));
    const mine = await history(here);
    const back = mine.find((m) => m.from === "east" && m.to.includes("north"))!;
    assertStringIncludes(back.text!, "by Friday");
    // North went on from the answer, to ana.
    const last = mine.at(-1)!;
    assertEquals([last.from, last.to], ["north", ["ana"]]);
    assertStringIncludes(last.text!, "north heard:");
  });
});

test("another chat of the same space: said there, answered back", async () => {
  await setup(async ({ rt, personal, say, history }) => {
    await rt.call("member.set", {
      space: personal,
      member: { kind: "agent", id: "east" },
      role: "editor",
    }, { actor: ana });
    const other = await say("@east a note for later", { in: personal });
    const here = await say(
      `do send_message {"thread":"${other}","to":"east","text":"Anything new?"}`,
      { in: personal },
    );
    assert((await history(other)).some((m) => m.from === "north" && m.text === "Anything new?"));
    assert(
      (await history(here)).some((m) => m.from === "east" && m.text?.includes("Anything new?")),
    );
  });
});

test("from Personal, a routine kept in another space waits for its person's yes; with it, it starts a chat there each run", async () => {
  await setup(async ({ rt, personal, launch, say }) => {
    const routine = {
      in: launch,
      name: "Launch check",
      text: "How's it going?",
      agent: "east",
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    };
    // Launch's people would see what Personal's work may draw on: Ana is asked first.
    await rt.call("chat.send", {
      text: `do schedule_routine ${JSON.stringify(routine)}`,
      in: personal,
    }, { actor: ana });
    await rt.idle();
    const asked = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
    assertEquals(asked.map((a) => [a.work, a.name]), [["share", "Launch"]]);
    assertEquals(await rt.query<Routine[]>("routine.list", { in: launch }, { actor: ana }), []);
    // With her yes, it's made as the tool makes it (as her, for her agent there): kept there.
    assertEquals(await yesToShares(rt, ana), 1);
    const [kept] = await rt.query<Routine[]>("routine.list", { in: launch }, { actor: ana });
    assertEquals([kept.name, kept.in, kept.by], ["Launch check", launch, "ana"]);
  });
});

test("from a shared space, an agent reaches only that space, and says how to get work done elsewhere", async () => {
  await setup(async ({ rt, launch, personal, say }) => {
    // A space ana shares with bob: north there reaches only it.
    const { space: shared } = await rt.call<{ space: string }>("space.create", {
      name: "Team",
    }, { actor: ana });
    await join(rt, shared, bob, "editor", ana);
    await say(`do list_conversations {"in":"${launch}"}`, { in: shared });
    assertStringIncludes(
      got.north[0],
      `You can't read the space "${launch}" from this conversation`,
    );
    await say(`do list_conversations {"in":"${personal}"}`, { in: shared });
    assertStringIncludes(got.north[1], "You can't read the space");
  });
});

test("a chat its person can't write in is refused, wherever the agent is", async () => {
  await setup(async ({ rt, say }) => {
    // Bob's own space, which ana isn't in: no chat of it is hers to read, or write in.
    const { space: bobs } = await rt.call<{ space: string }>("space.create", { name: "Bob's" }, {
      actor: bob,
    });
    const { thread: his } = await rt.call<{ thread: string }>("chat.send", {
      text: "hi",
      in: bobs,
    }, { actor: bob });
    await rt.idle();
    await say(`do send_message {"thread":"${his}","text":"hello"}`, {});
    assertStringIncludes(got.north[0], `Not sent: there's no chat "${his}"`);
  });
});

/**
 * Personal's north says something in a chat of Launch, where north answers it there: and that
 * north asks ana something, in a chat of its own. However she answers, its turn there resumes,
 * and what it then says comes back to Personal.
 */
async function handedAndAsked(
  { there, say }: {
    there: string;
    say: (said: string, where: { thread?: string }) => Promise<string>;
  },
) {
  const ask = `do send_message ${
    JSON.stringify({ to: "ana", in: "new_thread", text: "Which color?" })
  }`;
  return await say(
    `do send_message ${JSON.stringify({ thread: there, to: "north", text: ask })}`,
    {},
  );
}

test("asked something from another space's chat, a person answers where asked, and it comes back", async () => {
  await setup(async ({ rt, there, say, history }) => {
    const here = await handedAndAsked({ there, say });
    const [question] = await rt.query<Message[]>("message.questions", { person: "ana" }, {
      actor: ana,
    });
    assertEquals([question.from, question.text], ["north", "Which color?"]);
    // As a page sends it: the chat and the words.
    await say("Blue", { thread: question.thread });
    assertEquals(await rt.query("message.questions", { person: "ana" }, { actor: ana }), []);
    const back = (await history(here)).find((m) => m.from === "north" && m.to.includes("north"))!;
    assertStringIncludes(back.text!, "ana: Blue");
    const last = (await history(here)).at(-1)!;
    assertEquals([last.from, last.to], ["north", ["ana"]]);
    assertStringIncludes(last.text!, "Blue");
  });
});

test("told in the chat it was handed, that she answered elsewhere, its turn there resumes and answers back", async () => {
  await setup(async ({ rt, there, say, history }) => {
    const here = await handedAndAsked({ there, say });
    await say("I answered in the other chat", { thread: there });
    assertEquals(await rt.query("message.questions", { person: "ana" }, { actor: ana }), []);
    const back = (await history(here)).find((m) => m.from === "north" && m.to.includes("north"))!;
    assertStringIncludes(back.text!, "I answered in the other chat");
    assertStringIncludes((await history(here)).at(-1)!.text!, "I answered in the other chat");
  });
});
