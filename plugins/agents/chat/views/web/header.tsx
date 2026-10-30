/**
 * A chat's header: what it's about, the space it's in (a link to its page),
 * and who's in it (agents as they're named, with their emoji); its menu, to move it to another space (the command
 * palette's space picker) or start another chat there. On a phone, a way to
 * start another (the sidebar is tucked away there). Its end keeps clear of
 * what the shell puts at the page's top right (`--copilotz-inset-end`: the
 * side panel's button).
 */
import type { ReactNode } from "react";
import {
  Avatar,
  Badge,
  Chip,
  IconButton,
  Menu,
  openPalette,
  Title,
} from "../../../../../hosts/web/mod.ts";
import { moveStep } from "./move.ts";

/** Someone in a chat, as it shows: an agent by its name and emoji. */
export type Someone = { name: string; agent: boolean; icon?: string };

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function Header(
  { title, thread, space, people, fresh, call }: {
    title: string;
    thread: string;
    space?: { _id: string; name: string; kind: string };
    people: Someone[];
    /** Where a new chat starts. */
    fresh: string;
    call: Call;
  },
): ReactNode {
  const shown = people.slice(0, 4);
  const personal = space?.kind === "personal";
  return (
    <header className="chat-head">
      <Title text={title} />
      <div className="chat-head-text">
        <h1 title={title}>{title}</h1>
        {space
          ? (
            <Chip
              size="sm"
              icon={personal ? "person" : undefined}
              className="chat-space"
              href={`/space/${encodeURIComponent(space._id)}`}
              title={`Open ${personal ? "Personal" : space.name}`}
            >
              {personal ? null : <Avatar name={space.name} kind="space" size={14} />}
              {personal ? "Personal" : space.name}
            </Chip>
          )
          : null}
      </div>
      {people.length
        ? (
          <div
            className="chat-people"
            role="img"
            aria-label={`In this chat: ${people.map((p) => p.name).join(", ")}`}
          >
            {shown.map((p) => (
              <Avatar
                key={p.name}
                name={p.name}
                kind={p.agent ? "agent" : "person"}
                icon={p.icon}
                size={26}
                title={p.name}
              />
            ))}
            {people.length > shown.length
              ? <Badge className="chat-people-more">+{people.length - shown.length}</Badge>
              : null}
          </div>
        )
        : null}
      <IconButton icon="compose" label="New chat" href={fresh} className="chat-head-new" />
      <Menu
        label="This chat: more"
        align="end"
        items={[
          {
            label: "Move to another space…",
            icon: "move",
            onSelect: () =>
              openPalette(moveStep({ thread, title, from: space?._id, call, open: true })),
          },
          { label: "New chat", icon: "compose", href: fresh },
        ]}
      />
    </header>
  );
}
