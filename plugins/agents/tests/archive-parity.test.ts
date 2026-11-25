/**
 * What archiving chats must leave as rc.64 had it, with no chat archived:
 * what `thread.recent` answers (chats, a contact's chat and its staff notes,
 * a chat with a subthread, a fork), what agents' `list_conversations` and
 * `read_conversation` say, and what a conversation records about its
 * threads as messages come (a person's, an agent's answer, in the notes, in
 * a subthread). Pinned before archiving was built.
 */
import { assertEquals } from "@std/assert";
import type { Event } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import type { Message, Thread } from "../chat/mod.ts";
import { ana, archiveKit, bob, carla, eve, type Kit } from "./archive-kit.ts";

/** What a list says a message says: its words (these have no files). */
const words = (m?: Message | null) => m?.text?.trim() ? m.text : undefined;

/** `thread.recent` as rc.64 answers it, worked out from the documents themselves. */
async function expected(k: Kit, ids: string[], params: { in?: string; limit?: number } = {}) {
  const threads = (await Promise.all(ids.map(k.thread))).filter((t): t is Thread => !!t)
    .filter((t) => !t.fork && (!params.in || t.in === params.in))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, params.limit ?? 20);
  const all = (await Promise.all(threads.map((t) => k.messages(t._id)))).flat();
  const by = new Map(all.map((m) => [m._id, m]));
  return threads.map((t) => ({
    ...t,
    first: words(by.get(t.opened ?? "")),
    last: words(by.get(t.latest ?? "")),
  }));
}

/** A shop with every kind of thread a list meets: the conversations' ids, by name. */
async function seeded(k: Kit) {
  const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
  await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
  const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
    thread: k.carlas,
  }, { actor: bob });
  await k.send({ thread: notes, text: "she ordered on Monday" }, bob);
  const side = await k.send({ in: k.shop, text: "sub prices" });
  const opening = (await k.messages(side)).find((m) => m.subthread)!;
  const [first] = await k.messages(plan);
  const { thread: fork } = await k.runtime.call<{ thread: string }>("chat.fork", {
    thread: plan,
    message: first._id,
  }, { actor: ana });
  const mine = await k.send({ in: k.personal, text: "my own" });
  return { plan, carlas: k.carlas, notes, side, sub: opening.subthread!, fork, mine };
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test("thread.recent answers as rc.64 did: newest first, forks under their message", async () => {
  await archiveKit(async (k) => {
    const ids = Object.values(await seeded(k));
    for (const who of [ana, bob, eve]) {
      assertEquals(
        json(await k.recent(who, { in: k.shop })),
        json(await expected(k, ids, { in: k.shop })),
      );
    }
    assertEquals(json(await k.recent(ana)), json(await expected(k, ids)));
    assertEquals(
      json(await k.recent(ana, { limit: 2 })),
      json(await expected(k, ids, { limit: 2 })),
    );
    // Bob reads the shop's, not Ana's Personal space.
    assertEquals(
      json(await k.recent(bob)),
      json((await expected(k, ids)).filter((t) => t.in === k.shop)),
    );
  });
});

/** A tool's words with ids and times named, so they can be compared. */
function named(said: string, ids: Record<string, string>) {
  let out = said.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "T");
  // Longest first: a chat's notes' id has the chat's in it.
  const longest = Object.entries(ids).sort(([, a], [, b]) => b.length - a.length);
  for (const [name, id] of longest) out = out.replaceAll(id, `<${name}>`);
  return out;
}

test("agents list and read conversations as rc.64 did", async () => {
  await archiveKit(async (k) => {
    const ids = await seeded(k);
    const asking = await k.send({ in: k.shop, text: "list" });
    await k.send({ thread: asking, text: `read ${ids.plan}` });
    await k.send({ thread: asking, text: `read ${ids.notes}` });
    const [listed, plan, notes] = k.outputs.map((o) => named(o, { ...ids, asking }));
    assertEquals(listed, LISTED);
    assertEquals(plan, PLAN);
    assertEquals(notes, NOTES);
  });
});

const LISTED = [
  "- <side> · 2 messages · last T",
  "  opened: sub prices",
  "  latest: lead heard: scout heard: prices",
  "- <notes> “Carla” (staff notes about <carlas>) · 2 messages · last T",
  "  opened: (nothing to read)",
  "  latest: lead heard: she ordered on Monday",
  "- <carlas> “Carla” · 2 messages · last T",
  "  opened: (nothing to read)",
  "  latest: lead heard: where's my order?",
  "- <plan> · 2 messages · last T",
  "  opened: the plan for the quarter",
  "  latest: lead heard: the plan for the quarter",
].join("\n");
const PLAN = [
  "Conversation <plan>:",
  "[T] ana → lead: the plan for the quarter",
  "[T] lead → ana: lead heard: the plan for the quarter",
].join("\n");
const NOTES = [
  "Conversation <notes> “Carla” (staff notes about <carlas>):",
  "[T] bob → lead: she ordered on Monday",
  "[T] lead → bob: lead heard: she ordered on Monday",
].join("\n");

/** What a conversation's writes recorded about threads: each event, its thread by name. */
const threadEvents = (events: Event[], ids: Record<string, string>) =>
  events.filter((e) => e.type.startsWith("thread.")).map((e) => {
    const id = String(e.data._id);
    const name = Object.entries(ids).find(([, v]) => v === id)?.[0] ?? "?";
    const { changed, removed } = e.data as { changed?: string[]; removed?: string[] };
    return [
      e.type,
      name,
      ...(changed ? [changed.join(",")] : []),
      ...(removed ? [removed.join(",")] : []),
    ]
      .join(" ");
  });

test("a conversation's record of its threads, as rc.64 kept it", async () => {
  await archiveKit(async (k) => {
    const from = k.events.length;
    const ids = await seeded(k);
    assertEquals(threadEvents(k.events.slice(from), ids), RECORD);
  });
});

// A thread's summary moves with each shared message it has; nothing is ever removed from one.
const RECORD = [
  "thread.created plan",
  "thread.updated plan at,latest,messages ",
  "thread.updated carlas at,latest,messages ",
  "thread.updated carlas at,latest,messages ",
  "thread.created notes",
  "thread.updated notes at,latest,messages ",
  "thread.updated notes at,latest,messages ",
  "thread.created side",
  "thread.created sub",
  "thread.updated sub at,latest,messages ",
  "thread.updated side at,latest,messages ",
  "thread.created fork",
  "thread.created mine",
  "thread.updated mine at,latest,messages ",
];
