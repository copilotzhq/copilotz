/**
 * What archiving checks, server side, on every store: the newest message the
 * person saw (`latest`) against the whole conversation, the chat, its staff
 * notes, every subthread at every level and what opens them. A message after
 * it anywhere there, and the chat isn't put away (`conflict`); the newest
 * itself, or one as old (a tie counts as seen), and it is. `null` says nothing
 * was seen: anything said keeps it. Messages anywhere else don't count, nor
 * an agent's private steps.
 */
import { assert, assertEquals } from "@std/assert";
import type { Actor, Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
import type { Message } from "../chat/mod.ts";
import { ana, archiveKit, bob, carla, type Kit } from "./archive-kit.ts";

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

const archive = (k: Kit, latest: string | null | undefined, thread = k.carlas) =>
  code(k.runtime.call("chat.archive", {
    thread,
    archived: true,
    ...(latest !== undefined ? { latest } : {}),
  }, { actor: bob }));

const restore = (k: Kit) =>
  k.runtime.call("chat.archive", { thread: k.carlas, archived: false }, { actor: bob });

/**
 * Carla's chat as a whole: what she asked, Lead's answer, staff notes, and,
 * from the notes, a subthread two levels down (Lead asks Scout, who asks
 * Deep). In a contact's chat itself, an agent works with what she reaches,
 * and opens no subthread.
 */
export async function conversation(k: Kit) {
  await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
  const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
    thread: k.carlas,
  }, { actor: bob });
  await k.send({ thread: notes, text: "deep prices" }, bob);
  const first = (await k.messages(notes)).find((m) => m.subthread)!.subthread!;
  const second = (await k.messages(first)).find((m) => m.subthread)!.subthread!;
  return { notes, first, second };
}

/** Where a new message lands, and what it is: written by someone, or an agent's opening. */
export type Landing = "chat" | "notes" | "subthread" | "deeper" | "opening";
export const LANDINGS: Landing[] = ["chat", "notes", "subthread", "deeper", "opening"];

/** Lands a new message there, everything after it done: the new message's id. */
export async function land(
  k: Kit,
  where: Landing,
  c: { notes: string; first: string; second: string },
  n: number,
): Promise<string> {
  const say = async (thread: string, actor: Actor) => {
    const { message } = await k.runtime.call<{ message: string }>("chat.send", {
      thread,
      text: `news ${n}`,
      to: [],
    }, { actor });
    await k.runtime.idle();
    return message;
  };
  if (where === "chat") return await say(k.carlas, carla);
  // Someone else than Bob, who archives: his own messages count as seen.
  if (where === "notes") return await say(c.notes, ana);
  if (where === "subthread") return await say(c.first, ana);
  if (where === "deeper") return await say(c.second, ana);
  // Lead opens a subthread to Bob, from the notes, and waits on him: no answer follows.
  await k.send({ thread: c.notes, text: "aside bob" }, bob);
  const opening = (await k.messages(c.notes)).filter((m) => m.subthread && m.to.includes("bob"))
    .at(-1)!;
  return opening._id;
}

/** The newest message said in these threads (no private step), as kept. */
async function newest(k: Kit, threads: string[]): Promise<Message> {
  const all = (await Promise.all(threads.map((t) => k.messages(t)))).flat()
    .filter((m) => !m.private);
  return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

for (const [store, make] of Object.entries(stores)) {
  test(`${store}: a message anywhere in the conversation after what was seen keeps it out`, async () => {
    await archiveKit(async (k) => {
      const c = await conversation(k);
      const everywhere = async () => [
        k.carlas,
        c.notes,
        ...(await k.threads()).filter((t) => t.fork).map((t) => t._id),
      ];
      const results: string[] = [];
      for (const [n, where] of LANDINGS.entries()) {
        const before = await newest(k, await everywhere());
        const landed = await land(k, where, c, n);
        assertEquals((await newest(k, await everywhere()))._id, landed, `${where} is newest`);
        // Seen before it landed: kept out. Seen with it: put away.
        results.push(`${where}: ${await archive(k, before._id)} ${await archive(k, landed)}`);
        await restore(k);
      }
      assertEquals(results, LANDINGS.map((where) => `${where}: conflict done`));
    }, { store: make });
  });

  test(`${store}: having seen nothing (null), anything said keeps it; a tie counts as seen`, async () => {
    await archiveKit(async (k) => {
      // Nothing said yet.
      assertEquals(await archive(k, null), "done");
      await restore(k);
      const c = await conversation(k);
      assertEquals(await archive(k, null), "conflict");
      // A message as old as the one seen, elsewhere in it (an answer and its copy share a time).
      const [seen] = (await k.messages(c.notes)).slice(-1);
      const at = new Date(Date.parse(seen.at) + 60_000).toISOString();
      const twin = (id: string, thread: string) => ({
        _id: id,
        thread,
        in: k.shop,
        from: "ana",
        to: [],
        text: id,
        hops: 0,
        at,
      });
      await k.runtime.call("test.message", { message: twin("t1", c.notes) });
      await k.runtime.call("test.message", { message: twin("t2", k.carlas) });
      assertEquals(await archive(k, "t1"), "done");
      await restore(k);
      // A moment later, anywhere in it: not seen.
      await k.runtime.call("test.message", {
        message: { ...twin("t3", c.second), at: new Date(Date.parse(at) + 1).toISOString() },
      });
      assertEquals(await archive(k, "t1"), "conflict");
      assertEquals(await archive(k, "t3"), "done");
    }, { store: make });
  });
}

test("what doesn't count: an agent's private step, another chat, a fork of it", async () => {
  await archiveKit(async (k) => {
    const c = await conversation(k);
    const seen = (await newest(k, [k.carlas, c.notes, c.first, c.second]))._id;
    // A step of Lead's, a message in another chat, and a fork's own message, after it.
    await k.send({ thread: k.carlas, text: "note" }, bob);
    const step = (await k.messages(k.carlas)).find((m) => m.private && m.from === "lead");
    assert(step, "a private step");
    const last = (await newest(k, [k.carlas]))._id;
    await k.send({ in: k.shop, text: "another chat", to: [] }, bob);
    const { thread: fork } = await k.runtime.call<{ thread: string }>("chat.fork", {
      thread: k.carlas,
      message: last,
    }, { actor: bob });
    await k.send({ thread: fork, text: "in the fork", to: [] }, bob);
    // What Lead said after its step counts; nothing else does.
    assertEquals(await archive(k, seen), "conflict");
    assertEquals(await archive(k, last), "done");
  });
});

test("what the archiver said themselves counts as seen, wherever it is", async () => {
  await archiveKit(async (k) => {
    const c = await conversation(k);
    const seen = (await newest(k, [k.carlas, c.notes, c.first, c.second]))._id;
    for (const thread of [c.notes, c.first, c.second]) {
      await k.send({ thread, text: "Resolved, closing.", to: [] }, bob);
    }
    assertEquals(await archive(k, seen), "done");
    await restore(k);
    assertEquals(await archive(k, null), "conflict");
  });
});
