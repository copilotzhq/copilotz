/**
 * Archiving chats on the web: a chat's header, a list's row and the palette
 * archive it, saying what was shown last (`latest`), or restore it; a refusal
 * is said. Archived, a chat's page (and its notes') says so, with Restore.
 * The Chats tab ends with a folded "Archived" that reads nothing until it's
 * unfolded or the tab is searched, then lists the archived chats, found by
 * the same search; the palette finds them only while searching, said so.
 * In Brazilian Portuguese too.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dismissToast,
  LazyView,
  Menu,
  type MenuItem,
  type PaletteControl,
  type PaletteGroup,
  setWords,
} from "../../../hosts/web/mod.ts";
import { toastState } from "../../../hosts/web/toolkit/toast-state.ts";
import { wordsOf } from "../../../hosts/web/words.ts";
import { ptBR } from "../../../hosts/web/pt-br/mod.ts";
import { test } from "../../../testing/mod.ts";
import { archiveInput, seenOf } from "../chat/views/web/archive.ts";
import { ArchivedNote } from "../chat/views/web/archived-note.tsx";
import { archivedView } from "../chat/views/web/archived.tsx";
import { ChatRow } from "../chat/views/web/chat-row.tsx";
import { chatsView } from "../chat/views/web/chats.tsx";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { Header } from "../chat/views/web/header.tsx";
import type { Listed } from "../chat/views/web/listed.ts";
import { chatPaletteView } from "../chat/views/web/palette.tsx";
import { Shelf } from "../chat/views/web/shelf.tsx";

const at = new Date().toISOString();
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

/** Every element of `type` in what was drawn, however deep in its children. */
function elements(node: unknown, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const inside = elements(el.props.children, type);
  return el.type === type ? [el, ...inside] : inside;
}

/** A Call that notes what it's asked, and answers (or refuses) as told. */
function calls(refuse?: Error) {
  const made: [string, unknown][] = [];
  const call = <R,>(action: string, input?: unknown) => {
    made.push([action, input]);
    return refuse ? Promise.reject(refuse) : Promise.resolve({} as R);
  };
  return { made, call };
}

/** A menu's items, by what they say. */
const itemsOf = (node: unknown) =>
  (elements(node, Menu)[0].props.items as (MenuItem | "separator")[])
    .filter((i): i is MenuItem => i !== "separator");

const header = (call: ReturnType<typeof calls>["call"], archive?: { archived: boolean }) =>
  Header({
    title: "Plan the week",
    thread: "t1",
    space: { _id: "s1", name: "Launch", kind: "shared" },
    people: [],
    fresh: "/?in=s1",
    call,
    ...(archive ? { archive: { ...archive, latest: "m9" } } : {}),
  });

test("a chat's header archives it, saying what it showed last, or restores it", async () => {
  const { made, call } = calls();
  const items = itemsOf(header(call, { archived: false }));
  assertEquals(items.map((i) => i.label), [
    "Rename…",
    "Move to another space…",
    "Archive",
    "New chat",
  ]);
  items[2].onSelect!();
  const restoring = itemsOf(header(call, { archived: true }));
  assertEquals(restoring[2].label, "Restore");
  restoring[2].onSelect!();
  await Promise.resolve();
  assertEquals(made, [
    ["chat.archive", { thread: "t1", archived: true, latest: "m9" }],
    ["chat.archive", { thread: "t1", archived: false }],
  ]);
});

test("a refused archive, from a menu, is said", async () => {
  const refused = Object.assign(new Error("Something new was said in it."), { code: "conflict" });
  const { call } = calls(refused);
  itemsOf(header(call, { archived: false }))[2].onSelect!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const said = toastState().toasts.at(-1)!;
  assertEquals([said.tone, said.message], ["destructive", "Something new was said in it."]);
  dismissToast(said.id);
});

const thread = (id: string, more: Partial<Listed> = {}): Listed =>
  ({
    _id: id,
    title: `Chat ${id}`,
    at,
    in: "s1",
    agents: ["maya"],
    messages: 3,
    latest: `${id}-m3`,
    last: "Sounds good",
    ...more,
  }) as Listed;

test("a list's row archives its chat; an archived one's restores it", async () => {
  const { made, call } = calls();
  const row = (t: Listed) => itemsOf(ChatRow({ thread: t, compact: false, call }));
  const items = row(thread("a"));
  assertEquals(items.map((i) => i.label), ["Rename…", "Move to another space…", "Archive"]);
  items[2].onSelect!();
  const archived = row(thread("b", { archived: at }));
  assertEquals(archived[2].label, "Restore");
  archived[2].onSelect!();
  await Promise.resolve();
  assertEquals(made, [
    ["chat.archive", { thread: "a", archived: true, latest: "a-m3" }],
    ["chat.archive", { thread: "b", archived: false }],
  ]);
});

/** A View context answering every query with `rows`, noting what it asked. */
function viewCtx(
  rows: unknown,
  hints: Record<string, unknown> = {},
  // deno-lint-ignore no-explicit-any
): { ctx: any; asked: unknown[] } {
  const asked: unknown[] = [];
  const { call } = calls();
  return {
    asked,
    ctx: {
      hints,
      resources: {},
      viewer: { name: "ana", label: "Ana" },
      call,
      show: () => null,
      db: {
        collection: () => ({
          query: (name: string, params: unknown) => {
            asked.push([name, params]);
            return { value: rows };
          },
          find: () => ({ value: rows }),
          findOne: () => ({ value: null }),
        }),
      },
    },
  };
}

const lazies = (node: unknown) =>
  elements(node, LazyView).map((l) => [l.props.kind, l.props.item, l.props.hints]);

test("the Chats tab ends folded under Archived: nothing of it read until it's opened or searched", () => {
  const fold = (o: { open?: boolean; search?: string; compact?: boolean }) =>
    Shelf({
      space: "s1",
      compact: !!o.compact,
      search: o.search ?? "",
      open: !!o.open,
      fold: () => {},
    });
  assertEquals(lazies(fold({})), []);
  assertStringIncludes(html(fold({})), "Archived");
  assertEquals(lazies(fold({ open: true })), [["chats.archived", { _id: "s1" }, {}]]);
  assertEquals(lazies(fold({ search: " plan ", compact: true })), [
    ["chats.archived", { _id: "s1" }, { mode: "panel", search: "plan" }],
  ]);
  // The tab itself draws it, after its chats, and with none.
  for (const rows of [[thread("a")], []]) {
    const { ctx } = viewCtx(rows);
    const drawn = html(chatsView({ _id: "s1" }, ctx));
    assertStringIncludes(drawn, 'class="chats-archived"');
  }
});

test("the archived ones, unfolded: newest first, found by the search, each with Restore", () => {
  const rows = [thread("a", { archived: at, title: "Pricing" }), thread("b", { archived: at })];
  const { ctx, asked } = viewCtx(rows);
  const all = archivedView({ _id: "s1" }, ctx);
  assertEquals(asked, [["recent", { limit: 100, archived: true, in: "s1" }]]);
  assertEquals(elements(all, ChatRow).map((r) => (r.props.thread as Listed)._id), ["a", "b"]);
  assertStringIncludes(html(all), "Restore");
  const found = archivedView({ _id: "s1" }, viewCtx(rows, { search: "pricing" }).ctx);
  assertEquals(elements(found, ChatRow).map((r) => (r.props.thread as Listed)._id), ["a"]);
  assertStringIncludes(
    html(archivedView({ _id: "s1" }, viewCtx(rows, { search: "zzz" }).ctx)),
    "No chats match “zzz”.",
  );
  assertStringIncludes(
    html(archivedView({ _id: "s1" }, viewCtx([]).ctx)),
    "No archived chats here.",
  );
});

/** A conversation's page over fake threads, by id. */
function pageOf(threads: Record<string, unknown>, id: string) {
  const { call } = calls();
  const ctx = {
    name: "test",
    hints: {},
    resources: {},
    viewer: { name: "sam", label: "Sam" },
    call,
    emit: () => Promise.resolve(),
    show: () => null,
    db: {
      collection: (name: string) => ({
        findOne: (filter: { _id: string }) => ({
          value: name === "thread"
            ? threads[filter._id] ?? null
            : name === "space"
            ? { _id: "s1", name: "Support", kind: "shared" }
            : null,
        }),
        find: () => ({ value: [] }),
        query: () => ({ value: undefined }),
      }),
    },
  };
  return conversationView({ _id: id }, ctx as never);
}

test("an archived chat's page says so, with Restore, as its notes' page does", () => {
  const chat = { _id: "c1", in: "s1", title: "Order 12", latest: "m2", at, archived: at };
  const notes = { _id: "c1:notes", in: "s1", about: "c1", title: "Order 12", latest: "n4", at };
  const shownOn = (id: string, threads: Record<string, unknown>) => {
    const page = pageOf(threads, id);
    return {
      notes: elements(page, ArchivedNote).map((n) => [n.props.thread, n.props.part]),
      archive: elements(page, Header)[0].props.archive,
    };
  };
  assertEquals(shownOn("c1", { c1: chat }), {
    notes: [["c1", undefined]],
    archive: { archived: true, latest: "m2" },
  });
  assertEquals(shownOn("c1:notes", { c1: chat, "c1:notes": notes }), {
    notes: [["c1:notes", "notes"]],
    archive: { archived: true, latest: "n4" },
  });
  const { archived: _, ...back } = chat;
  assertEquals(shownOn("c1", { c1: back }), {
    notes: [],
    archive: { archived: false, latest: "m2" },
  });
  const note = html(<ArchivedNote thread="c1" call={calls().call} />);
  assertStringIncludes(note, "This chat is archived");
  assertStringIncludes(note, "A new message brings it back.");
  assertStringIncludes(
    html(<ArchivedNote thread="c1:notes" part="notes" call={calls().call} />),
    "Archived, with the chat",
  );
});

const early = "2026-11-25T10:00:00.000Z";
const late = "2026-11-25T11:00:00.000Z";

// Review H1 and M1: a notes page said the notes' latest, and an empty chat said nothing.
test("archiving says the newest it shows of the chat and the thread open; showing none, null", () => {
  const chat = { _id: "c1", in: "s1", title: "Order 12", latest: "m2", at: late };
  const notes = { _id: "c1:notes", in: "s1", about: "c1", latest: "n4", at: early };
  const archiveOn = (id: string, threads: Record<string, unknown>) =>
    elements(pageOf(threads, id), Header)[0].props.archive;
  assertEquals(archiveOn("c1:notes", { c1: chat, "c1:notes": notes }), {
    archived: false,
    latest: "m2",
  });
  assertEquals(
    archiveOn("c1:notes", { c1: { ...chat, at: early }, "c1:notes": { ...notes, at: late } }),
    { archived: false, latest: "n4" },
  );
  const empty = { _id: "c9", in: "s1", messages: 0, at: early };
  assertEquals(archiveOn("c9", { c9: empty }), { archived: false, latest: null });
  // What archiving then asks: what was shown, or that nothing was.
  assertEquals(archiveInput({ thread: "c9", archived: false, latest: null }), {
    thread: "c9",
    archived: true,
    latest: null,
  });
  assertEquals(archiveInput({ thread: "c9", archived: false }), {
    thread: "c9",
    archived: true,
    latest: null,
  });
  assertEquals(archiveInput({ thread: "c9", archived: true, latest: "m2" }), {
    thread: "c9",
    archived: false,
  });
  // The newest of what's shown, by when each last moved.
  assertEquals(seenOf(chat, notes), "m2");
  assertEquals(seenOf({ ...chat, at: early }, { ...notes, at: late }), "n4");
  assertEquals(seenOf(empty, undefined, null), null);
});

test("a list's notes row says the newest of it and its chat's row; an empty row, null", async () => {
  const { made, call } = calls();
  const chat = thread("c1", { latest: "m2", at: late });
  const notes = thread("c1:notes", { about: "c1", latest: "n4", at: early });
  const row = (t: Listed, latest: string | null) =>
    itemsOf(ChatRow({ thread: t, latest, compact: false, call }))[2].onSelect!();
  row(notes, seenOf(notes, chat));
  row(thread("e", { messages: 0, latest: undefined }), null);
  await Promise.resolve();
  assertEquals(made, [
    ["chat.archive", { thread: "c1:notes", archived: true, latest: "m2" }],
    ["chat.archive", { thread: "e", archived: true, latest: null }],
  ]);
});

// Review L2: a subthread's page offered Archive, and said nothing, when its chat was archived.
test("a subthread's page follows its chat: archived, it says so, and its menus restore it", async () => {
  const chat = { _id: "c1", in: "s1", title: "Order 12", latest: "m2", at: early, archived: late };
  const sub = {
    _id: "m1:sub",
    in: "s1",
    fork: true,
    parent: { thread: "c1", message: "m1" },
    latest: "s3",
    at: late,
  };
  const deeper = {
    _id: "s3:sub",
    in: "s1",
    fork: true,
    parent: { thread: "m1:sub", message: "s3" },
    latest: "d1",
    at: late,
  };
  for (const [id, latest] of [["m1:sub", "s3"], ["s3:sub", "d1"]]) {
    const page = pageOf({ c1: chat, "m1:sub": sub, "s3:sub": deeper }, id);
    assertEquals(elements(page, ArchivedNote).map((n) => [n.props.thread, n.props.part]), [
      [id, "subthread"],
    ]);
    assertEquals(elements(page, Header)[0].props.archive, { archived: true, latest });
  }
  assertStringIncludes(
    html(<ArchivedNote thread="m1:sub" part="subthread" call={calls().call} />),
    "Archived, with the chat it",
  );
  const open = palette({ open: sub as Listed, threads: { c1: chat, "m1:sub": sub } });
  const restore = open.groups.find((g) => g.title === "This chat")!.items.at(-1)!;
  assertEquals(restore.label, "Restore this chat");
  // And the notes page's palette says the newest it shows; an empty chat's, none.
  const notes = { _id: "c1:notes", in: "s1", about: "c1", latest: "n4", at: late };
  const { archived: _, ...back } = chat;
  const onNotes = palette({ open: notes as Listed, threads: { c1: back, "c1:notes": notes } });
  await onNotes.groups.find((g) => g.title === "This chat")!.items.at(-1)!.run!(
    {} as PaletteControl,
  );
  const empty = thread("e", { messages: 0, latest: undefined });
  const onEmpty = palette({ open: empty, threads: { e: empty } });
  await onEmpty.groups.find((g) => g.title === "This chat")!.items.at(-1)!.run!(
    {} as PaletteControl,
  );
  assertEquals([...onNotes.made, ...onEmpty.made], [
    ["chat.archive", { thread: "c1:notes", archived: true, latest: "n4" }],
    ["chat.archive", { thread: "e", archived: true, latest: null }],
  ]);
});

/** The palette's groups over fake rows: active chats, archived ones, the open chat. */
function palette(o: { search?: string; open?: Listed; threads?: Record<string, unknown> }) {
  const { made, call } = calls();
  const asked: unknown[] = [];
  const groups = chatPaletteView(undefined, {
    hints: {
      search: o.search ?? "",
      in: "s1",
      ...(o.open ? { page: { kind: "thread", id: o.open._id } } : {}),
    },
    resources: {},
    call,
    show: () => null,
    db: {
      collection: (name: string) => ({
        query: (_: string, params: { archived?: boolean }) => {
          asked.push(params);
          return { value: params.archived ? [thread("old", { archived: at })] : [thread("a")] };
        },
        find: () => ({
          value: name === "space" ? [{ _id: "s1", name: "Launch", kind: "shared" }] : [],
        }),
        findOne: (filter: { _id: string }) => ({
          value: name !== "thread"
            ? null
            : o.threads
            ? o.threads[filter._id] ?? null
            : o.open ?? null,
        }),
      }),
    },
  } as never) as PaletteGroup[];
  return { groups, asked, made };
}

test("the palette archives or restores the chat open, and finds archived ones only by searching", async () => {
  const open = palette({ open: thread("a") });
  const here = open.groups.find((g) => g.title === "This chat")!.items.at(-1)!;
  assertEquals(here.label, "Archive this chat");
  await here.run!({} as PaletteControl);
  assertEquals(open.made, [["chat.archive", { thread: "a", archived: true, latest: "a-m3" }]]);
  const shelved = palette({ open: thread("old", { archived: at }) });
  const restore = shelved.groups.find((g) => g.title === "This chat")!.items.at(-1)!;
  assertEquals(restore.label, "Restore this chat");
  await restore.run!({} as PaletteControl);
  assertEquals(shelved.made, [["chat.archive", { thread: "old", archived: false }]]);

  // Idle: archived ones aren't read, nor listed.
  const idle = palette({});
  assertEquals(idle.asked, [{ limit: 100 }]);
  const chats = (p: ReturnType<typeof palette>) =>
    p.groups.find((g) => g.title === "Chats")!.items.map((i) => [i.label, i.description]);
  assertEquals(chats(idle), [["Chat a", "Launch"]]);
  const searching = palette({ search: "chat" });
  assertEquals(searching.asked, [{ limit: 100 }, { limit: 100, archived: true }]);
  assertEquals(chats(searching), [["Chat a", "Launch"], ["Chat old", "Archived, in Launch"]]);
});

test("in Brazilian Portuguese", () => {
  const restore = setWords(wordsOf([ptBR]));
  try {
    const { call } = calls();
    assertEquals(itemsOf(header(call, { archived: false }))[2].label, "Arquivar");
    assertEquals(itemsOf(header(call, { archived: true }))[2].label, "Restaurar");
    assertStringIncludes(
      html(Shelf({ space: "s1", compact: false, search: "", open: false, fold: () => {} })),
      "Arquivadas",
    );
    assertStringIncludes(
      html(<ArchivedNote thread="c1" call={call} />),
      "Esta conversa está arquivada",
    );
    const searching = palette({ search: "chat", open: thread("a") });
    assert(searching.groups.some((g) => g.items.some((i) => i.label === "Arquivar esta conversa")));
    assert(
      searching.groups.some((g) => g.items.some((i) => i.description === "Arquivada, em Launch")),
    );
  } finally {
    restore();
  }
});
