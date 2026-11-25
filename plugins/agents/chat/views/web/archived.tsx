/**
 * A space's archived chats (kind `chats.archived`, item `{ _id }`, the
 * space; none, every space's the person reads): the latest hundred put away
 * (`thread.recent`'s `archived`), newest first, each as the Chats tab shows a
 * chat, with Restore in its menu; those matching what's searched
 * (`hints.search`), when something is. Shown under the tab's folded
 * "Archived" (see shelf.tsx), only once it's unfolded or searched; compact
 * in a side panel (`hints.mode: "panel"`).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Skeleton } from "../../../../../hosts/web/mod.ts";
import { ChatRow } from "./chat-row.tsx";
import { type Listed, matches } from "./listed.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

/** How many it lists: the latest. */
const LIMIT = 100;

export const archivedView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const threads = ctx.db.collection("thread").query<Listed[]>("recent", {
    limit: LIMIT,
    archived: true,
    ...(item._id ? { in: item._id } : {}),
  }).value;
  const compact = ctx.hints.mode === "panel";
  const search = typeof ctx.hints.search === "string" ? ctx.hints.search.trim() : "";
  const style = <style href="chat-web" precedence="copilotz">{STYLE}</style>;
  if (threads === undefined) {
    return (
      <ul className="chats-list" aria-busy="true">
        {style}
        <Skeleton as="li" height={compact ? 44 : 58} radius="lg" />
      </ul>
    );
  }
  const shown = threads.filter((t) => matches(t, search));
  if (!shown.length) {
    return (
      <p className="chats-none">
        {style}
        {search ? say("noChatsMatch", { search }) : say("archivedNone")}
      </p>
    );
  }
  return (
    <ul className="chats-list" aria-label={say("archived")}>
      {style}
      {shown.map((t) => <ChatRow key={t._id} thread={t} compact={compact} call={ctx.call} />)}
    </ul>
  );
};
