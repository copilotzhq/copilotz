/**
 * A chat's header: what it's about, the space it's in (a link to its page),
 * and who's in it (agents as they're named, with their emoji); what the
 * chat offers beside it (`tools`: its staff notes' button); its menu, to
 * move it to another space (the command palette's space picker, then who'll
 * see it there) or start another chat there. On a phone, a way to start
 * another (the sidebar is tucked away there). Its end keeps clear of what
 * the shell puts at the page's top right (`--copilotz-inset-end`: the side
 * panel's button).
 */
import type { ReactNode } from "react";
import {
  Avatar,
  Badge,
  Chip,
  formatNumber,
  IconButton,
  Menu,
  openPalette,
  Title,
} from "../../../../../hosts/web/mod.ts";
import { moveStep } from "./move.tsx";
import { say } from "./words.ts";

/** Someone in a chat, as it shows: an agent by its name and emoji; a person, with their picture. */
export type Someone = { name: string; agent: boolean; icon?: string; picture?: string };

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function Header(
  { title, thread, space, people, fresh, call, tools }: {
    title: string;
    thread: string;
    space?: { _id: string; name: string; kind: string };
    people: Someone[];
    /** Where a new chat starts. */
    fresh: string;
    call: Call;
    /** Before its menu: what the chat offers beside it (its staff notes' button). */
    tools?: ReactNode;
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
              title={say("openSpace", { space: personal ? say("personal") : space.name })}
            >
              {personal ? null : <Avatar name={space.name} kind="space" size={14} />}
              {personal ? say("personal") : space.name}
            </Chip>
          )
          : null}
      </div>
      {people.length
        ? (
          <div
            className="chat-people"
            role="img"
            aria-label={say("inThisChat", { names: people.map((p) => p.name).join(", ") })}
          >
            {shown.map((p) => (
              <Avatar
                key={p.name}
                name={p.name}
                kind={p.agent ? "agent" : "person"}
                icon={p.icon}
                picture={p.picture}
                size={26}
                title={p.name}
              />
            ))}
            {people.length > shown.length
              ? (
                <Badge className="chat-people-more">
                  +{formatNumber(people.length - shown.length)}
                </Badge>
              )
              : null}
          </div>
        )
        : null}
      {tools}
      <IconButton icon="compose" label={say("newChat")} href={fresh} className="chat-head-new" />
      <Menu
        label={say("chatMore")}
        align="end"
        items={[
          {
            label: say("moveToSpace"),
            icon: "move",
            onSelect: () =>
              openPalette(moveStep({ thread, title, from: space?._id, call, open: true })),
          },
          { label: say("newChat"), icon: "compose", href: fresh },
        ]}
      />
    </header>
  );
}
