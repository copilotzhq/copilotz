/**
 * Archiving a chat (`chat.archive`) from a menu (its header's, a list's
 * row's) or the palette: "Archive", or "Restore" once it's archived, done at
 * once (it's undone as easily). Archiving says the newest message the page
 * or row drew (`latest`, see views/seen.ts). Something newer in the
 * conversation, and it's refused: a toast says so, with a way to the chat.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, type MenuItem, message, toast } from "../../../../../hosts/web/mod.ts";
import type { Message } from "../../collections/message.ts";
import { notesOf } from "../../shared/notes.ts";
import { newestOf } from "../seen.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What archiving or restoring a chat asks: the chat (or its notes), whether it's archived now. */
export type Archiving = {
  thread: string;
  /** Whether it's archived now: it restores it. */
  archived: boolean;
  /** The newest message drawn (`newestOf`); null or left out, none was. */
  latest?: string | null;
  /** The chat's page, to see what's new when archiving is refused. */
  open?: string;
};

/** The input `chat.archive` takes to do the opposite of what's so now. */
export const archiveInput = ({ thread, archived, latest }: Archiving) => ({
  thread,
  archived: !archived,
  ...(!archived ? { latest: latest ?? null } : {}),
});

/** Archives it, or restores it; what refuses it, a toast says. */
export async function archiving(call: Call, o: Archiving): Promise<void> {
  try {
    await call("chat.archive", archiveInput(o));
  } catch (e) {
    const newer = (e as { code?: string }).code === "conflict";
    toast(newer ? <Newer open={o.open} /> : message(e), newer ? "warning" : "destructive");
  }
}

/** A menu's item that archives a chat, or restores it. */
export function archiveItem(o: Archiving & { call: Call }): MenuItem {
  return {
    label: say(o.archived ? "restore" : "archive"),
    icon: o.archived ? "restore" : "archive",
    onSelect: () => void archiving(o.call, o),
  };
}

/** The newest message a conversation's page draws: its own, and its notes' while their lane is open. */
export function drawnLatest(ctx: ViewContext<ReactNode>, thread: string, lane: boolean) {
  const said = (id: string) =>
    ctx.db.collection<Message>("message").query<Message[]>("conversation", {
      thread: id,
      limit: 120,
    }).value ?? [];
  return newestOf(said(thread), lane ? said(notesOf(thread)) : []);
}

/** Archiving refused: something newer arrived, and where to see it. */
function Newer({ open }: { open?: string }): ReactNode {
  return (
    <span className="chat-newer">
      {say("archiveNewer")}
      {open ? <Button size="sm" variant="outline" href={open}>{say("openChat")}</Button> : null}
    </span>
  );
}
