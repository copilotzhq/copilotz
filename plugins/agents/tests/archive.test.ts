/**
 * Archiving a chat (`chat.archive`): a person who may write where it is puts
 * it away, for everyone who sees it, and brings it back; not a viewer, someone
 * outside, an agent, a key, a routine or a contact. Lists leave it out
 * (`thread.recent`), with its staff notes, and list it apart when asked
 * (`archived: true`); agents' `list_conversations` leaves it out, and still
 * reads it by id. Asked about its notes or a subthread, it's the chat that's
 * archived: they go with it, and never say so themselves. Nothing in it
 * changes; archiving twice changes nothing more; and a front end that says
 * what it saw last (`latest`) never puts away what came after. Moving keeps
 * it archived; erasing erases it.
 */
import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import type { Actor, Event, Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
import type { Message, Thread } from "../chat/mod.ts";
import { ana, archiveKit, bob, carla, eve, type Kit } from "./archive-kit.ts";

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

const archive = (k: Kit, actor: Actor, input: Record<string, unknown>) =>
  k.runtime.call<{ thread: string; archived: boolean }>("chat.archive", input, { actor });

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** The ids a list answers someone, in order. */
const ids = async (k: Kit, actor: Actor, params: Record<string, unknown> = {}) =>
  (await k.recent(actor, params)).map((t) => t._id);

/** A contact's chat with its staff notes, and the notes' id. */
async function withNotes(k: Kit) {
  await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
  const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
    thread: k.carlas,
  }, { actor: bob });
  await k.send({ thread: notes, text: "she ordered on Monday" }, bob);
  return notes;
}

for (const [store, make] of Object.entries(stores)) {
  test(`${store}: an editor archives a chat, for everyone who sees it, and restores it`, async () => {
    await archiveKit(async (k) => {
      const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
      const other = await k.send({ in: k.shop, text: "the launch party" });
      assertEquals(await archive(k, bob, { thread: plan, archived: true }), {
        thread: plan,
        archived: true,
      });
      const kept = await k.thread(plan);
      assert(kept?.archived && !Number.isNaN(Date.parse(kept.archived)), JSON.stringify(kept));
      for (const who of [ana, bob, eve]) {
        assertEquals(await ids(k, who, { in: k.shop }), [other, k.carlas]);
        assertEquals(await ids(k, who, { in: k.shop, archived: true }), [plan]);
        assertEquals(await ids(k, who, { archived: true }), [plan]);
      }
      assertEquals(await archive(k, ana, { thread: plan, archived: false }), {
        thread: plan,
        archived: false,
      });
      assertEquals((await k.thread(plan))?.archived, undefined);
      for (const who of [ana, bob, eve]) {
        assertEquals(await ids(k, who, { in: k.shop }), [other, plan, k.carlas]);
        assertEquals(await ids(k, who, { in: k.shop, archived: true }), []);
      }
    }, { store: make });
  });

  test(`${store}: a chat's staff notes go with it, archived from either`, async () => {
    await archiveKit(async (k) => {
      const notes = await withNotes(k);
      // Asked about the notes, it's the chat that's archived.
      assertEquals(await archive(k, bob, { thread: notes, archived: true }), {
        thread: k.carlas,
        archived: true,
      });
      assert((await k.thread(k.carlas))?.archived);
      assertEquals((await k.thread(notes))?.archived, undefined);
      for (const who of [ana, bob]) {
        assertEquals(await ids(k, who, { in: k.shop }), []);
        assertEquals(await ids(k, who, { in: k.shop, archived: true }), [k.carlas]);
      }
      // Restored from the chat, both are listed again.
      await archive(k, ana, { thread: k.carlas, archived: false });
      assertEquals(await ids(k, bob, { in: k.shop }), [notes, k.carlas]);
    }, { store: make });
  });

  // Review H1: from its notes, the notes' latest was checked, and the chat was archived.
  test(`${store}: archived from its notes, what the chat said since keeps it out`, async () => {
    await archiveKit(async (k) => {
      await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
      const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
        thread: k.carlas,
      }, { actor: bob });
      await k.send({ thread: notes, text: "she ordered on Monday", to: [] }, bob);
      const notesLatest = (await k.thread(notes))!.latest!;
      await k.send(
        { thread: k.carlas, text: "WRONG ADDRESS, please stop the delivery", to: [] },
        carla,
      );
      assertEquals(
        await code(archive(k, bob, { thread: notes, archived: true, latest: notesLatest })),
        "conflict",
      );
      assertEquals((await k.thread(k.carlas))?.archived, undefined);
      assertEquals(await ids(k, bob, { in: k.shop }), [k.carlas, notes]);
      // The newest of what the page showed, the chat's message now: it goes.
      const chatLatest = (await k.thread(k.carlas))!.latest!;
      assertEquals(
        await code(archive(k, bob, { thread: notes, archived: true, latest: chatLatest })),
        "done",
      );
      assert((await k.thread(k.carlas))?.archived);
    }, { store: make });
  });
}

test("a viewer, someone outside, an agent, a key, a routine and a contact don't archive it", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
    const tried = (actor: Actor, thread = plan) =>
      code(archive(k, actor, { thread, archived: true }));
    assertEquals(await tried(eve), "forbidden");
    assertEquals(await tried({ kind: "person", id: "zoe" }), "not_found");
    assertEquals(await tried({ kind: "agent", id: "lead", for: ana }), "forbidden");
    assertEquals(await tried({ ...ana, key: "k-ana" }), "forbidden");
    assertEquals(
      await tried({ ...ana, origin: { kind: "routine", id: "r1", name: "Daily", rev: 0 } }),
      "forbidden",
    );
    assertEquals(await tried(carla, k.carlas), "forbidden");
    assertEquals(await code(archive(k, ana, { thread: plan, archived: true, more: 1 })), "invalid");
    // Nothing archived.
    assertEquals(await ids(k, ana, { in: k.shop, archived: true }), []);
    // In a space put away, nobody writes: its chats stay as they are.
    await k.runtime.call("space.archive", { space: k.shop, archived: true }, { actor: ana });
    assertEquals(await tried(ana), "forbidden");
  });
});

// Review L1: a viewer was told "done" for what changed nothing, and "conflict" before "forbidden".
test("who may not archive it is told so first: before it's found changing nothing, or stale", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    const seen = (await k.thread(plan))!.latest!;
    await k.send({ thread: plan, text: "and the budget" });
    const tried = (input: Record<string, unknown>) =>
      code(archive(k, eve, { thread: plan, ...input }));
    assertEquals(await tried({ archived: true, latest: seen }), "forbidden");
    assertEquals(await tried({ archived: false }), "forbidden");
    await archive(k, ana, { thread: plan, archived: true });
    assertEquals(await tried({ archived: true }), "forbidden");
    assert((await k.thread(plan))?.archived);
  });
});

test("a subthread goes with its chat: archiving one, from any level, archives the chat", async () => {
  await archiveKit(async (k) => {
    const side = await k.send({ in: k.shop, text: "deep prices" });
    const sub = (await k.messages(side)).find((m) => m.subthread)!.subthread!;
    const deeper = (await k.messages(sub)).find((m) => m.subthread)!.subthread!;
    assertEquals(await archive(k, ana, { thread: deeper, archived: true }), {
      thread: side,
      archived: true,
    });
    assert((await k.thread(side))?.archived);
    assertEquals([(await k.thread(sub))?.archived, (await k.thread(deeper))?.archived], [
      undefined,
      undefined,
    ]);
    assertEquals(await ids(k, ana, { in: k.shop, archived: true }), [side]);
    assertEquals(await archive(k, ana, { thread: sub, archived: false }), {
      thread: side,
      archived: false,
    });
    assertEquals(await ids(k, ana, { in: k.shop, archived: true }), []);
  });
});

/** Everything a conversation keeps, `archived` aside. */
async function everything(k: Kit, threads: string[]) {
  const docs = await Promise.all(threads.map(async (id) => {
    const { archived: _, ...t } = (await k.thread(id))!;
    return [t, await k.messages(id)];
  }));
  return JSON.stringify(docs);
}

test("nothing in it changes: archiving records one change to the chat, and only that", async () => {
  await archiveKit(async (k) => {
    const notes = await withNotes(k);
    const before = await everything(k, [k.carlas, notes]);
    const from = k.events.length;
    await archive(k, bob, { thread: k.carlas, archived: true });
    // Twice: nothing more.
    const at = (await k.thread(k.carlas))!.archived;
    assertEquals(await archive(k, ana, { thread: notes, archived: true }), {
      thread: k.carlas,
      archived: true,
    });
    assertEquals((await k.thread(k.carlas))!.archived, at);
    await k.runtime.idle();
    const changes = (events: Event[]) =>
      events.filter((e) => !e.type.startsWith("action.")).map((e) => {
        const d = e.data as { _id?: string; changed?: string[]; removed?: string[] };
        return [e.type, d._id, d.changed, d.removed];
      });
    assertEquals(changes(k.events.slice(from)), [
      ["thread.updated", k.carlas, ["archived"], []],
    ]);
    assertEquals(await everything(k, [k.carlas, notes]), before);
    // Restored: the field goes, and nothing else changes. Restoring again records nothing.
    const again = k.events.length;
    await archive(k, bob, { thread: k.carlas, archived: false });
    await archive(k, bob, { thread: k.carlas, archived: false });
    await k.runtime.idle();
    assertEquals(changes(k.events.slice(again)), [
      ["thread.updated", k.carlas, [], ["archived"]],
    ]);
    assertEquals(await everything(k, [k.carlas, notes]), before);
  });
});

test("what the person saw last: a message after it, and the chat isn't put away", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    const seen = (await k.thread(plan))!.latest!;
    await k.send({ thread: plan, text: "and the budget" });
    assertEquals(
      await code(archive(k, bob, { thread: plan, archived: true, latest: seen })),
      "conflict",
    );
    assertEquals((await k.thread(plan))?.archived, undefined);
    const now = (await k.thread(plan))!.latest!;
    await archive(k, bob, { thread: plan, archived: true, latest: now });
    assert((await k.thread(plan))?.archived);
    // Asked about its notes, the chat counts too: what it said after the notes' latest keeps it.
    const notes = await withNotes(k);
    const theirs = (await k.thread(notes))!.latest!;
    await k.send({ thread: k.carlas, text: "any news?" }, carla);
    assertEquals(
      await code(archive(k, bob, { thread: notes, archived: true, latest: theirs })),
      "conflict",
    );
    // And what the notes said after the chat's latest, asked about them.
    const chats = (await k.thread(k.carlas))!.latest!;
    await k.send({ thread: notes, text: "she wrote again", to: [] }, ana);
    assertEquals(
      await code(archive(k, bob, { thread: notes, archived: true, latest: chats })),
      "conflict",
    );
    // The newest of the two, the notes' now: the chat said nothing since.
    const newest = (await k.thread(notes))!.latest!;
    await archive(k, bob, { thread: notes, archived: true, latest: newest });
    assert((await k.thread(k.carlas))?.archived);
  });
});

// Review M1: an empty chat had no latest to say, so its first message could be put away unseen.
test("a chat that showed nothing says so (latest: null): its first message keeps it out", async () => {
  await archiveKit(async (k) => {
    assertEquals((await k.thread(k.carlas))?.latest, undefined);
    await archive(k, bob, { thread: k.carlas, archived: true, latest: null });
    assert((await k.thread(k.carlas))?.archived);
    await archive(k, bob, { thread: k.carlas, archived: false });
    await k.send({ thread: k.carlas, text: "hello?" }, carla);
    assertEquals(
      await code(archive(k, bob, { thread: k.carlas, archived: true, latest: null })),
      "conflict",
    );
    assertEquals((await k.thread(k.carlas))?.archived, undefined);
  });
});

test("agents' list leaves an archived chat and its notes out, and still reads it by id", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    const notes = await withNotes(k);
    const asking = await k.send({ in: k.shop, text: "list" });
    const [all] = k.outputs.splice(0);
    for (const id of [plan, notes, k.carlas]) assertMatch(all, new RegExp(id));
    await archive(k, bob, { thread: plan, archived: true });
    await archive(k, bob, { thread: k.carlas, archived: true });
    await k.send({ thread: asking, text: "list" });
    assertEquals(k.outputs.splice(0), ["No other conversations in this space yet."]);
    await k.send({ thread: asking, text: `read ${plan}` });
    const [read] = k.outputs.splice(0);
    assertMatch(read, /ana → lead: the plan for the quarter/);
    assertNotMatch(read, /No conversation/);
  });
});

test("moving an archived chat keeps it archived; erasing it erases it", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    await archive(k, ana, { thread: plan, archived: true });
    await k.runtime.call("chat.move", { thread: plan, to: k.personal }, { actor: ana });
    assertEquals(await ids(k, ana, { in: k.personal, archived: true }), [plan]);
    assertEquals(await ids(k, ana, { in: k.personal }), []);
    await k.runtime.call("chat.erase", { thread: plan });
    assertEquals([await k.thread(plan), await k.messages(plan)], [null, [] as Message[]]);
    assertEquals(await ids(k, ana, { archived: true }), []);
  });
});

test("an archived chat's own document says when; nothing else of it does", async () => {
  await archiveKit(async (k) => {
    const notes = await withNotes(k);
    await archive(k, ana, { thread: k.carlas, archived: true });
    const [chat, theirs] = [await k.thread(k.carlas), await k.thread(notes)] as Thread[];
    assertEquals([typeof chat.archived, theirs.archived], ["string", undefined]);
  });
});
