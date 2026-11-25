// deno-lint-ignore-file no-explicit-any
/**
 * Archiving checks what the person was shown, wherever they archive from: a
 * new message anywhere in the conversation keeps it out (`conflict`) unless
 * the place they archived from showed it. A matrix of where they archive
 * from (a page's header or the palette on it: the chat, with its notes lane
 * or without, its notes, a subthread; a list's row; the terminal's open
 * conversation or `/archive <n>`), where the new message lands (the chat, its
 * notes, a subthread, one further down, an agent's opening to a person), and
 * whether it landed before what they were shown, or after.
 *
 * Two conversations hold every place: a contact's chat, whose subthreads hang
 * from its staff notes (an agent working for a contact opens none in the
 * chat), and a team's chat, whose subthreads hang from it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isValidElement, type ReactElement } from "react";
import { Writable } from "node:stream";
import { Menu, type MenuItem, type PaletteGroup } from "../../../hosts/web/mod.ts";
import { plain, terminal } from "../../../hosts/terminal/mod.ts";
import type { Actor, Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";
import type { Message, Thread } from "../chat/mod.ts";
import { notesOf } from "../chat/shared/notes.ts";
import { chatTerminal } from "../chat/terminal.ts";
import { ChatRow, rowLatest } from "../chat/views/web/chat-row.tsx";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { Header } from "../chat/views/web/header.tsx";
import { setNotesOpen } from "../chat/views/web/lane.ts";
import type { Listed } from "../chat/views/web/listed.ts";
import { chatPaletteView } from "../chat/views/web/palette.tsx";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { accessTerminal } from "../../access/spaces/terminal.ts";
import { ana, archiveKit, bob, carla, type Kit } from "./archive-kit.ts";

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** Every element of `type` in what was drawn, however deep in its children. */
function elements(node: unknown, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const inside = elements(el.props.children, type);
  return el.type === type ? [el, ...inside] : inside;
}

/** A menu's items. */
const itemsOf = (node: unknown) =>
  (elements(node, Menu)[0].props.items as (MenuItem | "separator")[])
    .filter((i): i is MenuItem => i !== "separator");

type Landing = "chat" | "notes" | "subthread" | "deeper" | "opening";

/** Who wrote it: Bob, who archives (his own messages count as seen), or someone else. */
type Author = "other" | "archiver";

/** One conversation: its chat, notes (a contact's), and the subthreads two levels down. */
type Place = { chat: string; notes?: string; first: string; second: string; from: string };

/** Lands a new message there, and waits for what follows. */
async function land(k: Kit, p: Place, where: Landing, n: number, author: Author) {
  const say = (thread: string, actor: Actor) =>
    k.send({ thread, text: `news ${n}`, to: [] }, actor);
  // Someone else than Bob, who archives: in a contact's chat, the contact.
  const other = where === "chat" && p.notes ? carla : ana;
  const by = author === "archiver" ? bob : other;
  if (where === "chat") await say(p.chat, by);
  else if (where === "notes") await say(p.notes!, by);
  else if (where === "subthread") await say(p.first, by);
  else if (where === "deeper") await say(p.second, by);
  // Lead opens a subthread to Bob, where its subthreads hang from, and waits on him.
  else await k.send({ thread: p.from, text: "aside bob" }, bob);
}

/** What a page or the palette is drawn from, read as Bob, as it is now. */
async function shown(k: Kit, page: string, lane: boolean) {
  setNotesOpen(bob.id, lane);
  const threads = new Map((await k.threads()).map((t) => [t._id, t]));
  const read = [page, ...(threads.has(notesOf(page)) ? [notesOf(page)] : [])];
  const said: Record<string, Message[]> = {};
  for (const id of read) {
    said[id] = await k.runtime.query<Message[]>("message.conversation", {
      thread: id,
      limit: 120,
    }, { actor: bob });
  }
  const recent = await k.recent(bob, { limit: 100 });
  const outcomes: Promise<string>[] = [];
  const ctx = {
    name: "test",
    hints: { in: k.shop, page: { kind: "thread", id: page }, search: "" },
    resources: {},
    viewer: { name: bob.id, label: "Bob" },
    call: (action: string, input: unknown) => {
      const p = k.runtime.call(action, input, { actor: bob });
      outcomes.push(code(p));
      return p.catch(() => {});
    },
    emit: () => Promise.resolve(),
    show: () => null,
    db: {
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => ({
          status: "ready",
          value: name === "thread"
            ? threads.get(f._id) ?? null
            : name === "space"
            ? { _id: k.shop, name: "Shop", kind: "shared" }
            : null,
        }),
        find: (f: { space?: string }) => ({
          status: "ready",
          value: name === "member"
            ? f.space === `thread:${k.carlas}` ? [{ member: `contact:${carla.id}` }] : []
            : name === "space"
            ? [{ _id: k.shop, name: "Shop", kind: "shared" }]
            : [],
        }),
        query: (q: string, params: { thread?: string; archived?: boolean }) => ({
          status: "ready",
          value: name === "message" && q === "conversation"
            ? said[params.thread ?? ""]
            : name === "thread" && q === "recent"
            ? params.archived ? [] : recent
            : undefined,
        }),
      }),
    },
  };
  /** Archives through what was drawn, as the person does: its outcome. */
  const after = async (act: () => unknown) => {
    await act();
    return await outcomes.at(-1)!;
  };
  return { ctx: ctx as any, after };
}

/** Where someone archives from, and the places what it shows covers. */
type Source = {
  name: string;
  shows: Landing[];
  /** Where what it draws last is said. */
  home: Landing;
  /** Archives, with the message landing before what it shows (`before`), or after. */
  archive(k: Kit, p: Place, before: boolean, landed: () => Promise<void>): Promise<string>;
};

/** A page's header, or the palette over it. */
function page(name: string, of: (p: Place) => string, lane: boolean, shows: Landing[]) {
  const home = shows[0] ?? "chat";
  const viaHeader: Source = {
    name: `${name} header`,
    shows,
    home,
    async archive(k, p, before, landed) {
      if (before) await landed();
      const { ctx, after } = await shown(k, of(p), lane);
      const drawn = conversationView({ _id: of(p) }, ctx);
      if (!before) await landed();
      const props = elements(drawn, Header)[0].props as Parameters<typeof Header>[0];
      return await after(() =>
        itemsOf(Header(props)).find((i) => i.label === "Archive")!.onSelect!()
      );
    },
  };
  const viaPalette: Source = {
    name: `${name} palette`,
    shows,
    home,
    async archive(k, p, before, landed) {
      if (before) await landed();
      const { ctx, after } = await shown(k, of(p), lane);
      const groups = chatPaletteView(undefined, ctx) as PaletteGroup[];
      if (!before) await landed();
      const item = groups.find((g) => g.title === "This chat")!.items
        .find((i) => i.label === "Archive this chat")!;
      return await after(() => item.run!({} as never));
    },
  };
  return [viaHeader, viaPalette];
}

/** A row of the Chats tab. */
function row(name: string, of: (p: Place) => string, shows: Landing[]): Source {
  return {
    name,
    shows,
    home: shows[0] ?? "chat",
    async archive(k, p, before, landed) {
      if (before) await landed();
      const { ctx, after } = await shown(k, of(p), false);
      const list = (await k.recent(bob, { in: k.shop, limit: 100 })) as unknown as Listed[];
      const listed = list.find((t) => t._id === of(p))!;
      const drawn = ChatRow({
        thread: listed,
        latest: rowLatest(listed, list),
        compact: false,
        call: ctx.call,
      });
      if (!before) await landed();
      return await after(() => itemsOf(drawn).find((i) => i.label === "Archive")!.onSelect!());
    },
  };
}

/** Bob's terminal, given what he types (a function runs between lines, or says the next). */
async function session(
  k: Kit,
  lines: (string | (() => Promise<string | void>))[],
  trap: { land?: () => Promise<void> } = {},
) {
  const { space } = await k.runtime.call<{ space: string }>("space.personal", {}, { actor: bob });
  // The terminal's reads, with someone writing right after what it shows is read.
  const runtime = {
    ...k.runtime,
    query: async (name: string, params: unknown, o: unknown) => {
      const answer = await k.runtime.query(name, params as never, o as never);
      if (name === "message.conversation" && trap.land) {
        const landing = trap.land;
        trap.land = undefined;
        await landing();
      }
      return answer;
    },
  };
  let out = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    { columns: 160, isTTY: false },
  );
  await terminal({
    runtime: runtime as never,
    me: bob.id,
    actor: bob,
    space,
    stdout,
    input: (async function* () {
      for (const line of lines) {
        if (typeof line === "string") yield line;
        else {
          const next = await line();
          if (typeof next === "string") yield next;
        }
      }
    })(),
  });
  return plain(out);
}

/** What the terminal said came of archiving `chat`. */
async function outcome(k: Kit, chat: string, out: string) {
  if ((await k.thread(chat))?.archived) return "done";
  assertStringIncludes(out, "Something new arrived in this conversation");
  return "conflict";
}

const terminalOpen: Source = {
  name: "terminal /archive (open)",
  shows: [],
  home: "chat",
  async archive(k, p, before, landed) {
    if (before) await landed();
    const trap: { land?: () => Promise<void> } = {};
    const out = await session(k, [
      `/open ${p.chat}`,
      // After it's drawn: right after `/archive` reads what the screen shows.
      () => {
        if (!before) trap.land = landed;
        return Promise.resolve();
      },
      "/archive",
    ], trap);
    return await outcome(k, p.chat, out);
  },
};

const terminalListed: Source = {
  name: "terminal /archive <n>",
  shows: ["chat"],
  home: "chat",
  async archive(k, p, before, landed) {
    if (before) await landed();
    const out = await session(k, [
      "/threads",
      async () => {
        if (!before) await landed();
        const { listed } = await k.runtime.query<{ listed: string[] }>("shell.mine", {
          person: bob.id,
        }, { actor: bob });
        return `/archive ${listed.indexOf(p.chat) + 1}`;
      },
    ]);
    return await outcome(k, p.chat, out);
  },
};

/**
 * Every source, every landing, by whom (an agent's opening is never the
 * archiver's), both timings: what each case came to, and what it should.
 * What the archiver says is seen wherever it lands: first, someone else says
 * something where the source draws, so nothing else is newer than it drew.
 */
async function matrix(k: Kit, p: Place, sources: Source[], landings: Landing[]) {
  const got: string[] = [];
  const expected: string[] = [];
  let n = 0;
  for (const before of [true, false]) {
    for (const where of landings) {
      for (const author of (where === "opening" ? ["other"] : ["other", "archiver"]) as Author[]) {
        for (const source of sources) {
          const name = `${source.name} × ${where} by ${author} × ${before ? "before" : "after"}`;
          if (author === "archiver") await land(k, p, source.home, n++, "other");
          const result = await source.archive(k, p, before, () => land(k, p, where, n++, author));
          const seen = author === "archiver" || (before && source.shows.includes(where));
          got.push(`${name}: ${result}`);
          expected.push(`${name}: ${seen ? "done" : "conflict"}`);
          if ((await k.thread(p.chat))?.archived) {
            await k.runtime.call("chat.archive", { thread: p.chat, archived: false }, {
              actor: bob,
            });
          }
        }
      }
    }
  }
  return { got, expected };
}

const plugins = [terminalPlugin, terminalShell, chatTerminal, accessTerminal];

test("a contact's chat: archived only over what the place it's archived from showed", async () => {
  await archiveKit(async (k) => {
    await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
    const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
      thread: k.carlas,
    }, { actor: bob });
    await k.send({ thread: notes, text: "deep prices" }, bob);
    const first = (await k.messages(notes)).find((m) => m.subthread)!.subthread!;
    const second = (await k.messages(first)).find((m) => m.subthread)!.subthread!;
    const p: Place = { chat: k.carlas, notes, first, second, from: notes };
    const lane: Landing[] = ["chat", "notes", "subthread", "opening"];
    const sources: Source[] = [
      ...page("chat page, notes lane open", (p) => p.chat, true, lane),
      ...page("chat page, notes lane closed", (p) => p.chat, false, ["chat"]),
      ...page("notes page", (p) => p.notes!, false, ["notes", "subthread", "opening"]),
      ...page("subthread page", (p) => p.first, false, ["subthread", "deeper"]),
      // Its notes row is drawn beside it, in the same list.
      row("chat row", (p) => p.chat, ["chat", "notes"]),
      row("notes row", (p) => p.notes!, ["notes"]),
      { ...terminalOpen, shows: ["chat"] },
      terminalListed,
    ];
    const { got, expected } = await matrix(k, p, sources, [
      "chat",
      "notes",
      "subthread",
      "deeper",
      "opening",
    ]);
    assertEquals(got.length, 216);
    assertEquals(got, expected);
  }, { plugins });
});

test("a team's chat: archived only over what the place it's archived from showed", async () => {
  await archiveKit(async (k) => {
    const chat = await k.send({ in: k.shop, text: "deep prices" }, bob);
    const first = (await k.messages(chat)).find((m) => m.subthread)!.subthread!;
    const second = (await k.messages(first)).find((m) => m.subthread)!.subthread!;
    const p: Place = { chat, first, second, from: chat };
    const sources: Source[] = [
      ...page("chat page", (p) => p.chat, false, ["chat", "subthread", "opening"]),
      ...page("subthread page", (p) => p.first, false, ["subthread", "deeper"]),
      row("chat row", (p) => p.chat, ["chat"]),
      { ...terminalOpen, shows: ["chat", "subthread", "opening"] },
      terminalListed,
    ];
    const { got, expected } = await matrix(k, p, sources, [
      "chat",
      "subthread",
      "deeper",
      "opening",
    ]);
    assertEquals(got.length, 98);
    assertEquals(got, expected);
  }, { plugins });
});

// Review H2 (round 2), the reviewer's reproduction: a notes page said the chat's latest message,
// which it never showed, and the chat went away over it. Now it says what it showed, and stays.
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};
async function headerOn(k: Kit, id: string, threads: string[]) {
  const docs: Record<string, Thread | null> = {};
  for (const t of threads) docs[t] = await k.thread(t);
  const said = await k.runtime.query<Message[]>("message.conversation", {
    thread: id,
    limit: 120,
  }, { actor: bob });
  const ctx = {
    name: "test",
    hints: {},
    resources: {},
    viewer: { name: "bob", label: "Bob" },
    call: () => Promise.resolve({}),
    emit: () => Promise.resolve(),
    show: () => null,
    db: {
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => ({
          value: name === "thread"
            ? docs[f._id] ?? null
            : name === "space"
            ? { _id: k.shop, name: "Shop", kind: "shared" }
            : null,
        }),
        find: () => ({ value: [] }),
        query: (q: string) => ({ value: q === "conversation" ? said : undefined }),
      }),
    },
  };
  const page = conversationView({ _id: id }, ctx as never);
  return {
    archive: elements(page, Header)[0].props.archive as { latest: string | null },
    shown: said.map((m) => m._id),
  };
}
for (const [name, store] of Object.entries(stores)) {
  test(`${name}: archived from the notes page over a customer's message it never showed`, async () => {
    await archiveKit(async (k) => {
      await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
      const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
        thread: k.carlas,
      }, { actor: bob });
      await k.send({ thread: notes, text: "she ordered on Monday", to: [] }, bob);
      const { message } = await k.runtime.call<{ message: string }>("chat.send", {
        thread: k.carlas,
        text: "WRONG ADDRESS, stop it",
        to: [],
      }, { actor: carla });
      await k.runtime.idle();
      const { archive, shown } = await headerOn(k, notes, [notes, k.carlas]);
      assert(!shown.includes(message), "the notes page doesn't show her message");
      assert(archive.latest !== message, "nor does its header say it was seen");
      assertEquals(archive.latest, shown.at(-1), "it says the newest it showed");
      assertEquals(
        await code(k.runtime.call("chat.archive", {
          thread: notes,
          archived: true,
          latest: archive.latest,
        }, { actor: bob })),
        "conflict",
      );
      assert(!(await k.thread(k.carlas))?.archived, "not put away over her message");
      const listed = (await k.recent(bob, { in: k.shop })).map((t) => t._id);
      assert(listed.includes(k.carlas) && listed.includes(notes));
    }, { store });
  });
}

// Review (round 3): a chat closed with a staff note ("Resolved, closing") couldn't be archived from
// its row or its page, where the notes' lane is closed by default.
for (const [name, store] of Object.entries(stores)) {
  test(`${name}: a chat closed with the archiver's own staff note archives from its row and page`, async () => {
    await archiveKit(async (k) => {
      await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
      await k.send({ thread: k.carlas, text: "@lead status?" }, bob);
      const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
        thread: k.carlas,
      }, { actor: bob });
      await k.send({ thread: notes, text: "Resolved: shipped today. Closing.", to: [] }, bob);
      const p: Place = { chat: k.carlas, notes, first: notes, second: notes, from: notes };
      const [chatRow] = [row("chat row", (p) => p.chat, [])];
      const [closed] = page("chat page, notes lane closed", (p) => p.chat, false, []);
      const now = () => Promise.resolve();
      const restore = () =>
        k.runtime.call("chat.archive", { thread: k.carlas, archived: false }, { actor: bob });
      assertEquals(await chatRow.archive(k, p, true, now), "done");
      await restore();
      assertEquals(await closed.archive(k, p, true, now), "done");
      await restore();
      // Someone else's note, the lane closed: not drawn, kept. The row draws its notes row beside it.
      await k.send({ thread: notes, text: "One more thing first", to: [] }, ana);
      assertEquals(await closed.archive(k, p, true, now), "conflict");
      assertEquals(await chatRow.archive(k, p, true, now), "done");
    }, { store });
  });
}
