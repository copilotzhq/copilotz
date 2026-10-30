/**
 * A space's chats (kind `chats`: its Chats tab, item `{ _id }`, the space):
 * the latest hundred, by when they were last written in (today, yesterday,
 * this week…), each with what it's called, what was said last, when, and
 * how long it is, and a menu to move it to another space; and a search over
 * them. In a side panel (`hints.mode: "panel"`), the same, compact, with a
 * new chat there (on a page, its header has one). Each opens full screen.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  openPalette,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import { byDay, lastOf, type Listed, matches, titleOf } from "./listed.ts";
import { moveStep } from "./move.ts";
import { STYLE } from "./style.ts";

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
  const fresh = space ? `/?in=${encodeURIComponent(space)}` : "/";
  if (!threads.length) {
    return (
      <EmptyState
        icon="chat"
        tone="primary"
        title="No chats here yet"
        className="chats-empty"
        action={<Button variant="primary" icon="compose" href={fresh}>New chat</Button>}
      >
        Start one: its agents work with what's in this space, and whoever's in it can follow along.
      </EmptyState>
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
          aria-label="Search chats"
          placeholder={`Search ${threads.length} chat${threads.length === 1 ? "" : "s"}`}
          autoComplete="off"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {compact
          ? <IconButton icon="compose" label="New chat here" variant="outline" href={fresh} />
          : null}
      </div>
      {groups.length
        ? groups.map((g) => (
          <section key={g.label} className="chats-group" aria-label={g.label}>
            <h3>{g.label}</h3>
            <ul className="chats-list">
              {g.items.map((t) => <Row key={t._id} thread={t} compact={compact} call={call} />)}
            </ul>
          </section>
        ))
        : <p className="chats-none">No chats match “{search.trim()}”.</p>}
      {full && !search ? <p className="chats-none">The latest {threads.length} are here.</p> : null}
    </div>
  );
}

function Row(
  { thread: t, compact, call }: { thread: Listed; compact: boolean; call: Call },
): ReactNode {
  const title = titleOf(t);
  const last = lastOf(t);
  return (
    <li className="chats-item">
      <a
        className="chats-row"
        href={`/thread/${encodeURIComponent(t._id)}${
          t.in ? `?in=${encodeURIComponent(t.in)}` : ""
        }`}
      >
        {compact ? null : (
          <span className="chats-row-icon" aria-hidden="true">
            <Icon name="chat" size={16} />
          </span>
        )}
        <span className="chats-row-text">
          <span className="chats-row-title">{title}</span>
          {last ? <span className="chats-row-last">{last}</span> : null}
        </span>
        <span className="chats-row-meta">
          <Time at={t.at} />
          {compact ? null : (
            <span className="chats-row-count">
              {t.messages} message{t.messages === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </a>
      <span className="chats-row-menu">
        <Menu
          label={`${title}: more`}
          align="end"
          size="sm"
          items={[{
            label: "Move to another space…",
            icon: "move",
            onSelect: () => openPalette(moveStep({ thread: t._id, title, from: t.in, call })),
          }]}
        />
      </span>
    </li>
  );
}
