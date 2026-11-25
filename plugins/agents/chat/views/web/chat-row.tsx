/**
 * A chat as a space's lists show it (its Chats tab, its archived ones): a
 * link that opens it full screen, with what it's called, what was said
 * last, when, and how long it is (all but on a side panel's compact rows);
 * and a menu to rename it, move it to another space, and archive it, or,
 * archived, restore it.
 */
import type { ReactNode } from "react";
import { Icon, Menu, openPalette, Time } from "../../../../../hosts/web/mod.ts";
import { archiveItem } from "./archive.ts";
import { lastOf, type Listed, titleOf } from "./listed.ts";
import { moveStep } from "./move.tsx";
import { renameStep } from "./rename.tsx";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function ChatRow(
  { thread: t, latest, compact, call }: {
    thread: Listed;
    /**
     * What archiving it says was shown last (see `seenOf`): for a notes row,
     * the newest of it and its chat's row. Left out, the row's own.
     */
    latest?: string | null;
    compact: boolean;
    call: Call;
  },
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
              {say("messageCount", { count: t.messages })}
            </span>
          )}
        </span>
      </a>
      <span className="chats-row-menu">
        <Menu
          label={say("rowMore", { title })}
          align="end"
          size="sm"
          items={[
            {
              label: say("rename"),
              icon: "pencil",
              onSelect: () => openPalette(renameStep({ thread: t._id, title, call })),
            },
            {
              label: say("moveToSpace"),
              icon: "move",
              onSelect: () => openPalette(moveStep({ thread: t._id, title, from: t.in, call })),
            },
            archiveItem({
              thread: t._id,
              archived: !!t.archived,
              latest: latest === undefined ? t.latest ?? null : latest,
              call,
            }),
          ]}
        />
      </span>
    </li>
  );
}
