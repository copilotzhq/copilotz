/**
 * What archiving costs the paths that don't archive anything: listing chats
 * reads nothing more for staff notes whose chat is on the same page; working
 * out a thread's chat reads nothing for a chat, its notes or a subthread of
 * a chat (one read a level only further down); a subthread's opening writes
 * nothing of its chat unless the chat is archived; its answer, one bring-back.
 */
import { assert, assertEquals } from "@std/assert";
import type { Store } from "../../../runtime/mod.ts";
import type { Transaction } from "../../../runtime/store.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
import type { Thread } from "../chat/mod.ts";
import { chatOf, chatOfId } from "../chat/shared/chat-of.ts";
import { ana, archiveKit, bob, carla, type Kit } from "./archive-kit.ts";

const stores: Record<string, () => Store | Promise<Store>> = {
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

/** What a call answers, and the round trips to the store it made, once everything before it is done. */
async function trips<T>(k: Kit, fn: () => Promise<T>): Promise<[T, number]> {
  await k.runtime.idle();
  const before = k.runtime.stats().roundTrips;
  const answer = await fn();
  return [answer, k.runtime.stats().roundTrips - before];
}

const ids = (threads: Thread[]) => threads.map((t) => t._id);

/** A contact's chat with staff notes, the notes said last. */
async function withNotes(k: Kit) {
  await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
  const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
    thread: k.carlas,
  }, { actor: bob });
  await k.send({ thread: notes, text: "she ordered on Monday", to: [] }, bob);
  return notes;
}

// Review M3: thread.recent read once more whenever its page held notes, even with nothing archived.
for (const [store, make] of Object.entries(stores)) {
  test(`${store}: listing chats reads nothing more for notes whose chat is listed too`, async () => {
    await archiveKit(async (k) => {
      await k.send({ in: k.personal, text: "my own plan" });
      const notes = await withNotes(k);
      // Each list asked once: a list asked again may be answered from what the runtime keeps.
      const [mine, plain] = await trips(k, () => k.recent(ana, { in: k.personal }));
      assertEquals(mine.length, 1);
      const [shop, listing] = await trips(k, () => k.recent(bob, { in: k.shop }));
      assertEquals([ids(shop), listing], [[notes, k.carlas], plain]);
      const [all, everywhere] = await trips(k, () => k.recent(ana, {}));
      assertEquals([ids(all).length, everywhere], [3, plain]);
      // Notes whose chat is off the page: one read, for whether it's archived.
      const [page, paged] = await trips(k, () => k.recent(bob, { in: k.shop, limit: 1 }));
      assertEquals([ids(page), paged], [[notes], plain + 1]);
    }, { store: make });
  });
}

/** A reader of threads that counts its reads. */
function reader(threads: Thread[]) {
  const reads: string[] = [];
  const db = {
    collection: <T>(_: string) => ({
      findOne: (filter: { _id: string }) => {
        reads.push(filter._id);
        return Promise.resolve((threads.find((t) => t._id === filter._id) ?? null) as T | null);
      },
    }),
  };
  return { db, reads };
}

// Review M2: a subthread's answer read its parent for its chat, every time.
test("a thread's chat: no read for a chat, its notes or a chat's subthread; one a level below", async () => {
  const at = "2026-11-25T10:00:00.000Z";
  const chat: Thread = { _id: "c1", at };
  const notes: Thread = { _id: "c1:notes", about: "c1", at };
  const sub: Thread = { _id: "m1:sub", fork: true, parent: { thread: "c1", message: "m1" }, at };
  const deeper: Thread = {
    _id: "m2:sub",
    fork: true,
    parent: { thread: "m1:sub", message: "m2" },
    at,
  };
  const inNotes: Thread = {
    _id: "m3:sub",
    fork: true,
    parent: { thread: "c1:notes", message: "m3" },
    at,
  };
  // A fork (chat.fork) is a chat of its own.
  const fork: Thread = { _id: "f1", fork: true, parent: { thread: "c1", message: "m1" }, at };
  const all = [chat, notes, sub, deeper, inNotes, fork];
  const cases: [Thread, string, string[]][] = [
    [chat, "c1", []],
    [notes, "c1", []],
    [sub, "c1", []],
    [deeper, "c1", ["m1:sub"]],
    [inNotes, "c1", ["c1:notes"]],
    [fork, "f1", []],
  ];
  for (const [thread, expected, read] of cases) {
    const { db, reads } = reader(all);
    assertEquals([await chatOf(db, thread), reads], [expected, read], thread._id);
  }
  // By id: a chat's is its own, read for nothing; a subthread's, read first.
  for (const [id, expected, read] of [["c1", "c1", []], ["m1:sub", "c1", ["m1:sub"]]] as const) {
    const { db, reads } = reader(all);
    assertEquals([await chatOfId(db, id), reads], [expected, read], id);
  }
});

/** Each commit's writes, as `<op> <collection> <what>`. */
function recorded() {
  const commits: string[][] = [];
  const make = () => {
    const store = memoryStore();
    return {
      ...store,
      transaction: <T>(
        epoch: number,
        work: (tx: Transaction) => Promise<T>,
        options?: Parameters<Store["transaction"]>[2],
      ) =>
        store.transaction(epoch, (tx) => {
          const writes: string[] = [];
          commits.push(writes);
          const watched: Transaction = {
            ...tx,
            insert: (collection, docs, o) => {
              for (const d of docs) {
                writes.push(
                  `insert ${collection} ${d._id} ${(d as { thread?: string }).thread ?? ""}`,
                );
              }
              return tx.insert(collection, docs, o);
            },
            update: (collection, filter, update, o) => {
              writes.push(
                `update ${collection} ${JSON.stringify(filter)} ${JSON.stringify(update)}`,
              );
              return tx.update(collection, filter, update, o);
            },
          };
          return work(watched);
        }, options),
    } as Store;
  };
  return { commits, make };
}

// Review M2: the commit opening a subthread wrote its chat's bring-back, archived or not.
test("a subthread's opening writes nothing of its chat unless it's archived; its answer, one bring-back", async () => {
  const { commits, make } = recorded();
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    commits.length = 0;
    await k.send({ thread: plan, text: "sub prices" });
    const opening = commits.find((c) => c.some((w) => /^insert thread \S+:sub /.test(w)))!;
    assert(opening, "the subthread was opened");
    // Each write's filter names the document first (what rules add comes after).
    const updated = (commit: string[]) =>
      commit.filter((w) => w.startsWith("update thread")).map((w) =>
        w.match(/"_id":"([^"]+)"(,"archived")?/)!.slice(1, 3).join("")
      );
    assertEquals(updated(opening), []);
    const sub = (await k.messages(plan)).find((m) => m.subthread)!.subthread!;
    const answer = commits.find((c) =>
      c.some((w) => w.startsWith("insert message") && w.endsWith(` ${sub}`) && w.includes(":reply"))
    )!;
    assert(answer, "scout answered");
    assertEquals(updated(answer), [sub, `${plan},"archived"`]);
  }, { store: make });
});
