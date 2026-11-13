/**
 * What chat offers in the command palette (kind `chat.palette`, the web
 * shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This chat**, the one open: moving it to another space (spaces'
 *   picker), with everything in it.
 * - **Chats** to go to: the latest few; while searching, the latest hundred,
 *   found by what they're called and what was said first and last, each
 *   saying its space.
 * - **Create:** a new chat where the person is, or in another space.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { go, type PaletteGroup } from "../../../../../hosts/web/mod.ts";
import type { Thread } from "../../collections/thread.ts";
import { type Listed, threadTitle, titleOf } from "./listed.ts";
import { moveStep } from "./move.tsx";
import { plain } from "./plain.ts";
import { say } from "./words.ts";

type Space = { _id: string; name: string; kind: string };

/** How many chats show with nothing typed, and while searching. */
const SHOWN = { idle: 5, searching: 8 };

const inSpace = (space?: string) => space ? `?in=${encodeURIComponent(space)}` : "";

export const chatPaletteView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const open = page.kind === "thread" ? page.id : undefined;
  const threads = ctx.db.collection("thread").query<Listed[]>("recent", { limit: 100 }).value;
  // The spaces the person reaches, read directly (the rules keep it to those): to say where each is.
  const spaces = ctx.db.collection<Space>("space").find({}).value;
  const thread = open ? ctx.db.collection<Thread>("thread").findOne({ _id: open }).value : null;
  if (!threads || !spaces) return null;
  const named = new Map(
    spaces.map((s) => [s._id, s.kind === "personal" ? say("personal") : s.name]),
  );
  const groups: PaletteGroup[] = [];

  if (open && thread) {
    const listed = threads.find((t) => t._id === open);
    const title = listed ? titleOf(listed) : threadTitle(thread) || say("thisChat");
    groups.push({
      title: say("thisChatGroup"),
      order: 10,
      items: [{
        key: "chat:move",
        label: say("moveThisChat"),
        icon: "move",
        keywords: [
          say("keywordSpace"),
          ...(thread.in && named.has(thread.in) ? [named.get(thread.in)!] : []),
        ],
        step: moveStep({ thread: open, title, from: thread.in, call: ctx.call, open: true }),
      }],
    });
  }

  groups.push({
    title: say("chats"),
    order: 30,
    limit: searching ? SHOWN.searching : SHOWN.idle,
    items: threads.filter((t) => t._id !== open).map((t) => ({
      key: `chat:${t._id}`,
      label: titleOf(t),
      icon: "chat" as const,
      ...(t.in && named.has(t.in) ? { description: named.get(t.in) } : {}),
      keywords: [plain(t.first), plain(t.last)].filter(Boolean),
      href: `/thread/${encodeURIComponent(t._id)}${inSpace(t.in)}`,
    })),
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
