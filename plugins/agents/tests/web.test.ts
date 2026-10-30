/**
 * Chats as the web lists them: what each is called, what was said last,
 * searching them, and grouping them by when they were last written in; a
 * title cut short for a step's name; what home greets someone as; whether
 * agents are working, held between a turn's steps; and agents as chat shows
 * them: their names, what `@` offers as you type and puts in, and which
 * names a refused message mentioned that don't answer where it went; and
 * which agents a message waits for, at work on an earlier one.
 */
import { assertEquals } from "@std/assert";
import type { Agent } from "../chat/mod.ts";
import {
  agentPath,
  matching,
  mention,
  mentionable,
  mentions,
  shownAll,
  shownAs,
  typingAt,
  unanswered,
} from "../chat/views/web/agents.ts";
import { byDay, lastOf, type Listed, matches, titleOf } from "../chat/views/web/listed.ts";
import { held } from "../chat/views/web/held.ts";
import { waitingOn } from "../chat/views/web/waiting.ts";
import { shortened } from "../chat/views/web/plain.ts";
import { greeted } from "../chat/views/web/who.ts";
import { test } from "../../../testing/mod.ts";

const chat = (at: string, fields: Partial<Listed> = {}): Listed => ({
  _id: at,
  at,
  messages: 2,
  ...fields,
});

test("what a chat is called in a list, and what was said last", () => {
  assertEquals(titleOf(chat("t", { title: "**Plan** the `launch`" })), "Plan the launch");
  assertEquals(titleOf(chat("t", { first: "# Hi there", last: "Bye" })), "Hi there");
  assertEquals(titleOf(chat("t", { last: "Only this" })), "Only this");
  assertEquals(titleOf(chat("t")), "New chat");
  assertEquals(lastOf(chat("t", { first: "Hi", last: "The tool says: 3" })), "The tool says: 3");
  assertEquals(lastOf(chat("t", { first: "Hi", last: "Hi" })), undefined);
});

test("searching chats: every word, any case, any accents", () => {
  const t = chat("t", { title: "Café plans", last: "We’ll meet on Friday" });
  assertEquals(matches(t, ""), true);
  assertEquals(matches(t, "cafe"), true);
  assertEquals(matches(t, "FRIDAY plans"), true);
  assertEquals(matches(t, "friday monday"), false);
});

test("chats by when they were last written in, newest first", () => {
  const now = new Date(2026, 9, 29, 15, 0);
  const at = (days: number, hour = 12) => new Date(2026, 9, 29 - days, hour, 0).toISOString();
  const groups = byDay([
    chat(at(40)),
    chat(at(0, 9)),
    chat(at(1)),
    chat(at(3)),
    chat(at(0, 14)),
    chat(at(400)),
    chat(at(20)),
    chat("not a time"),
  ], now);
  assertEquals(groups.map((g) => [g.label, g.items.length]), [
    ["Today", 2],
    ["Yesterday", 1],
    ["This week", 1],
    ["This month", 1],
    ["September", 1],
    ["September 2025", 1],
    ["Earlier", 1],
  ]);
  assertEquals(groups[0].items.map((t) => t.at), [at(0, 14), at(0, 9)]);
});

test("a title cut short for a step's name, and what home greets someone as", () => {
  assertEquals(shortened("Plan the launch"), "Plan the launch");
  assertEquals(
    shortened("Plan the launch party for Friday evening downtown", 20),
    "Plan the launch par…",
  );
  assertEquals(greeted("ana"), "Ana");
  assertEquals(greeted("ana@example.com"), "Ana");
  assertEquals(greeted("ana.lima@example.com"), "Ana");
  assertEquals(greeted(""), "");
});

test("agents working, held between a turn's steps: on at once, off once it's stayed off", async () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const working = held(120);
  const seen: boolean[] = [];
  const off = working.subscribe(() => seen.push(working.get()));
  assertEquals(working.get(), false);
  working.set(true);
  assertEquals(working.get(), true);
  // A step ends; the next comes within the hold: still on, nothing said.
  working.set(false);
  await sleep(40);
  working.set(true);
  await sleep(150);
  assertEquals(working.get(), true);
  // The last step ends: off once the hold has passed.
  working.set(false);
  await sleep(60);
  assertEquals(working.get(), true);
  await sleep(100);
  assertEquals(working.get(), false);
  assertEquals(seen, [true, false]);
  // Starting on, as a conversation opened mid-turn does.
  assertEquals(held(120, true).get(), true);
  working.stop();
  off();
});

test("agents as they show: by their name and emoji, or as they're called", () => {
  const maya: Agent = { instructions: "", model: "m", name: "Maya", icon: "🦉", in: "launch" };
  const researcher: Agent = { instructions: "", model: "m", description: "Digs" };
  assertEquals(shownAs("maya", maya), { name: "Maya", icon: "🦉" });
  assertEquals(shownAs("researcher", researcher), { name: "researcher" });
  assertEquals(shownAs("gone"), { name: "gone" });
  // Only agents: anyone else shows as themselves.
  assertEquals(shownAll(["maya", "ana", "researcher", "maya"], { maya, researcher }), {
    maya: { name: "Maya", icon: "🦉" },
    researcher: { name: "researcher" },
  });
  assertEquals(agentPath("maya 2"), "/agent/maya%202");
  // What `@` lists: who answers new chats first, then the others as they work there.
  assertEquals(
    mentionable({
      here: ["assistant", "maya", "researcher"],
      default: ["maya"],
      agents: { maya, researcher },
    }),
    [
      { id: "maya", name: "Maya", icon: "🦉" },
      { id: "assistant", name: "assistant" },
      { id: "researcher", name: "researcher", description: "Digs" },
    ],
  );
});

test("@: the name being typed at the caret, the agents it could be, and putting one in", () => {
  assertEquals(mentions("@maya and @researcher, again @maya. mail ana@example.com"), [
    "maya",
    "researcher",
  ]);
  assertEquals(typingAt("ask @ma", 7), { query: "ma", start: 4, end: 7 });
  assertEquals(typingAt("@", 1), { query: "", start: 0, end: 1 });
  // The caret inside a name: all of it is replaced.
  assertEquals(typingAt("hi @mazzy there", 6), { query: "ma", start: 3, end: 9 });
  assertEquals(typingAt("mail ana@exa", 12), undefined);
  assertEquals(typingAt("@maya done", 10), undefined);
  assertEquals(mention("ask @ma", { query: "ma", start: 4, end: 7 }, "maya"), {
    text: "ask @maya ",
    caret: 10,
  });
  assertEquals(mention("hi @mazzy there", { query: "ma", start: 3, end: 9 }, "maya"), {
    text: "hi @maya there",
    caret: 9,
  });
  const agents = [
    { id: "assistant", name: "assistant" },
    { id: "maya", name: "Maya Lima" },
    { id: "researcher", name: "researcher" },
    { id: "lima-bot", name: "Écrivain" },
  ];
  assertEquals(matching(agents, "").map((a) => a.id), [
    "assistant",
    "maya",
    "researcher",
    "lima-bot",
  ]);
  // Those that start with it first, then those with a word that does; any case, any accents.
  assertEquals(matching(agents, "LI").map((a) => a.id), ["lima-bot", "maya"]);
  assertEquals(matching(agents, "ecri").map((a) => a.id), ["lima-bot"]);
  assertEquals(matching(agents, "zz"), []);
});

test("which names a refused message mentioned that don't answer where it went", () => {
  // Agents or not, the View that helps says (it reads what each is).
  assertEquals(unanswered("@maya @bob ask @researcher too", ["researcher"]), ["maya", "bob"]);
  assertEquals(unanswered("no one named", []), []);
});

test("a message waits for agents at work on an earlier one, until they start on it or answer", () => {
  const m = { _id: "m2", thread: "t", to: ["assistant", "maya"] };
  const at = (agent: string, turn: string, thread = "t") => ({ thread, agent, turn });
  // The assistant is still on m1: m2 waits for it; Maya isn't at work.
  assertEquals(waitingOn(m, [at("assistant", "m1:assistant")], []), ["assistant"]);
  // Busy in a side thread doesn't hold this one.
  assertEquals(waitingOn(m, [at("assistant", "m1:assistant", "sub")], []), []);
  // It started on m2 (its turn is live, or wrote a step of it), or answered it: no longer waiting.
  assertEquals(waitingOn(m, [at("assistant", "m2:assistant")], []), []);
  assertEquals(
    waitingOn(m, [at("assistant", "m1:assistant")], [{ from: "assistant", turn: "m2:assistant" }]),
    [],
  );
  assertEquals(
    waitingOn(m, [at("assistant", "m1:assistant")], [{ from: "assistant", replyTo: "m2" }]),
    [],
  );
  // Each agent on its own.
  assertEquals(
    waitingOn(m, [at("assistant", "m1:assistant"), at("maya", "m0:maya")], []),
    ["assistant", "maya"],
  );
});
