/**
 * What chat offers in the command palette (kind `chat.palette`, the web
 * shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This chat**, the one open: renaming it, moving it to another space
 *   (spaces' picker), with everything in it, and archiving it, or restoring
 *   it (for staff notes, their chat).
 * - **Chats** to go to: the latest few; while searching, the latest hundred,
 *   found by what they're called and what was said first and last, each
 *   saying its space; and the archived ones after them, said so (read only
 *   while searching).
 * - **Create:** a new chat where the person is, or in another space.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { go, type PaletteGroup, type PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Thread } from "../../collections/thread.ts";
import { archiveInput, type Archiving } from "./archive.ts";
import { type Listed, threadTitle, titleOf } from "./listed.ts";
import { moveStep } from "./move.tsx";
import { renameStep } from "./rename.tsx";
import { plain } from "./plain.ts";
import { say } from "./words.ts";

type Space = { _id: string; name: string; kind: string };

/** How many chats show with nothing typed, and while searching. */
const SHOWN = { idle: 5, searching: 8 };

const inSpace = (space?: string) => space ? `?in=${encodeURIComponent(space)}` : "";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/**
 * Archiving the chat open, or restoring it (`chat.archive`): with what it
 * last said as shown, so nothing new since is put away unseen.
 */
const archiveThis = (call: Call, archiving: Archiving): PaletteItem => ({
  key: archiving.archived ? "chat:restore" : "chat:archive",
  label: say(archiving.archived ? "restoreThisChat" : "archiveThisChat"),
  icon: archiving.archived ? "restore" : "archive",
  keywords: [say(archiving.archived ? "keywordRestore" : "keywordArchive")],
  run: () => call("chat.archive", archiveInput(archiving)),
});

export const chatPaletteView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const open = page.kind === "thread" ? page.id : undefined;
  const threads = ctx.db.collection("thread").query<Listed[]>("recent", { limit: 100 }).value;
  // Archived ones only for a search: they're put away.
  const shelved = searching
    ? ctx.db.collection("thread").query<Listed[]>("recent", { limit: 100, archived: true }).value
    : [];
  // The spaces the person reaches, read directly (the rules keep it to those): to say where each is.
  const spaces = ctx.db.collection<Space>("space").find({}).value;
  const thread = open ? ctx.db.collection<Thread>("thread").findOne({ _id: open }).value : null;
  // Staff notes are archived with their chat: it says whether they are.
  const chat = thread?.about
    ? ctx.db.collection<Thread>("thread").findOne({ _id: thread.about }).value
    : thread;
  if (!threads || !spaces || !shelved) return null;
  const named = new Map(
    spaces.map((s) => [s._id, s.kind === "personal" ? say("personal") : s.name]),
  );
  const groups: PaletteGroup[] = [];

  if (open && thread) {
    const listed = [...threads, ...shelved].find((t) => t._id === open);
    const title = listed ? titleOf(listed) : threadTitle(thread) || say("thisChat");
    groups.push({
      title: say("thisChatGroup"),
      order: 10,
      items: [
        {
          key: "chat:rename-this",
          label: say("renameThisChat"),
          icon: "pencil",
          keywords: [say("keywordTitle")],
          step: renameStep({ thread: open, title, call: ctx.call }),
        },
        {
          key: "chat:move",
          label: say("moveThisChat"),
          icon: "move",
          keywords: [
            say("keywordSpace"),
            ...(thread.in && named.has(thread.in) ? [named.get(thread.in)!] : []),
          ],
          step: moveStep({ thread: open, title, from: thread.in, call: ctx.call, open: true }),
        },
        archiveThis(ctx.call, {
          thread: open,
          archived: !!chat?.archived,
          ...(thread.latest ? { latest: thread.latest } : {}),
        }),
      ],
    });
  }

  /** Where a chat is, as an item says it: its space; archived, so too. */
  const whereIs = (t: Listed) => {
    const space = t.in && named.has(t.in) ? named.get(t.in) : undefined;
    if (!t.archived) return space;
    return space ? say("archivedIn", { space }) : say("archived");
  };
  groups.push({
    title: say("chats"),
    order: 30,
    limit: searching ? SHOWN.searching : SHOWN.idle,
    items: [...threads, ...shelved].filter((t) => t._id !== open).map((t) => {
      const description = whereIs(t);
      return {
        key: `chat:${t._id}`,
        label: titleOf(t),
        icon: "chat" as const,
        ...(description ? { description } : {}),
        keywords: [plain(t.first), plain(t.last)].filter(Boolean),
        href: `/thread/${encodeURIComponent(t._id)}${inSpace(t.in)}`,
      };
    }),
  });

  groups.push({
    title: say("create"),
    order: 40,
    items: [
      {
        key: "chat:new",
        label: say("newChat"),
        icon: "compose",
        ...(here && named.has(here)
          ? { description: say("inSpace", { space: named.get(here)! }) }
          : {}),
        keywords: [say("keywordStart"), say("keywordConversation")],
        href: `/${inSpace(here)}`,
      },
      {
        key: "chat:new-in",
        label: say("newChatIn"),
        icon: "compose",
        keywords: [say("keywordStart"), say("keywordConversation"), say("keywordSpace")],
        step: {
          title: say("newChatIn"),
          placeholder: say("findSpace"),
          view: "space.pick",
          pick: (space) => go(`/${inSpace((space as Space)._id)}`),
        },
      },
    ],
  });
  return groups;
};
