/**
 * A space's chats (kind `chats`: its Chats tab, item `{ _id }`, the space):
 * the latest hundred, by when they were last written in (today, yesterday,
 * this week…), each with what it's called, what was said last, when, and
 * how long it is, and a menu to rename it, move it to another space or
 * archive it; and a search over them. Archived ones are apart, at the end,
 * under a folded "Archived" (see shelf.tsx), read only once it's unfolded or
 * the tab is searched. In a side panel (`hints.mode: "panel"`), the same,
 * compact, with a new chat there (on a page, its header has one). Each opens
 * full screen.
 */
import { type ReactNode, useDeferredValue, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, EmptyState, IconButton, Input, Skeleton } from "../../../../../hosts/web/mod.ts";
import { ChatRow, rowLatest } from "./chat-row.tsx";
import { byDay, type Listed, matches } from "./listed.ts";
import { Shelf } from "./shelf.tsx";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How many a tab lists: the latest. */
const LIMIT = 100;

export const chatsView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : undefined);
  const threads = ctx.db.collection("thread").query<Listed[]>("recent", {
    limit: LIMIT,
    ...(space ? { in: space } : {}),
  }).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="chat-web" precedence="copilotz">{STYLE}</style>;
  if (threads === undefined) {
    return (
      <div className="chats" aria-busy="true">
        {style}
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={compact ? 44 : 58} radius="lg" />)}
      </div>
    );
  }
  return (
    <>
      {style}
      <Chats
        threads={threads}
        space={space}
        compact={compact}
        full={threads.length >= LIMIT}
        call={ctx.call}
      />
    </>
  );
};

function Chats(
  { threads, space, compact, full, call }: {
    threads: Listed[];
    space?: string;
    compact: boolean;
    /** There may be more than these. */
    full: boolean;
    call: Call;
  },
): ReactNode {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  // The archived ones are found by what's typed once typing pauses: each search reads them again.
  const searched = useDeferredValue(search);
  const fresh = space ? `/?in=${encodeURIComponent(space)}` : "/";
  const shelf = (
    <Shelf
      space={space}
      compact={compact}
      search={searched}
      open={open}
      fold={setOpen}
    />
  );
  if (!threads.length) {
    return (
      <div className={`chats${compact ? " chats-compact" : ""}`}>
        <EmptyState
          icon="chat"
          tone="primary"
          title={say("noChatsTitle")}
          className="chats-empty"
          action={<Button variant="primary" icon="compose" href={fresh}>{say("newChat")}</Button>}
        >
          {say("noChatsBody")}
        </EmptyState>
        {shelf}
      </div>
    );
  }
  const shown = threads.filter((t) => matches(t, search));
  const groups = byDay(shown);
  return (
    <div className={`chats${compact ? " chats-compact" : ""}`}>
      <div className="chats-tools">
        <Input
          icon="search"
          type="search"
          size={compact ? "sm" : "md"}
          className="chats-search"
          aria-label={say("searchChatsLabel")}
          placeholder={say("searchChats", { count: threads.length })}
          autoComplete="off"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {compact
          ? <IconButton icon="compose" label={say("newChatHere")} variant="outline" href={fresh} />
          : null}
      </div>
      {groups.length
        ? groups.map((g) => (
          <section key={g.label} className="chats-group" aria-label={g.label}>
            <h3>{g.label}</h3>
            <ul className="chats-list">
              {g.items.map((t) => (
                <ChatRow
                  key={t._id}
                  thread={t}
                  latest={rowLatest(t, shown)}
                  compact={compact}
                  call={call}
                />
              ))}
            </ul>
          </section>
        ))
        : <p className="chats-none">{say("noChatsMatch", { search: search.trim() })}</p>}
      {full && !search
        ? <p className="chats-none">{say("latestAreHere", { count: threads.length })}</p>
        : null}
      {shelf}
    </div>
  );
}
