/**
 * A space's page frame and header: its mark, its name (those who manage it
 * rename it in place), whether it's Personal or shared (or archived) and the
 * person's role there, its people's faces, inviting someone (those who
 * manage a shared space in use), a new chat there, and a menu of the rest:
 * renaming, archiving or restoring it, leaving it (each asking first, in the
 * command palette), its settings. What the page shows goes under it.
 */
import { type ReactNode, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Icon,
  IconButton,
  InlineEdit,
  Menu,
  type MenuItem,
  openPalette,
  Page,
} from "../../../../../hosts/web/mod.ts";
import type { Member, Reached } from "../../contract.ts";
import { InviteDialog } from "./invite-dialog.tsx";
import { archiveStep, leaveStep } from "./steps.ts";
import { spacePath } from "./tabs.ts";
import { peopleIn, roleName, spaceName, whoOf } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** At most this many faces show; the rest are counted. */
const FACES = 5;

/** Who works in a shared space, in words: "3 people and 2 agents work here." */
const together = (people: number, agents: number) => {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return agents
    ? `${count(people, "person", "people")} and ${count(agents, "agent", "agents")} work here.`
    : `${count(people, "person works", "people work")} here; no agent does yet.`;
};

export function SpaceHeader(
  { space, members, manage, me, call, children }: {
    space: Reached;
    members: Member[];
    manage: boolean;
    me?: string;
    call: Call;
    children: ReactNode;
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const personal = space.kind === "personal";
  const name = spaceName(space);
  const people = peopleIn(members);
  const agents = members.filter((m) => whoOf(m.member).kind === "agent").length;
  const role = members.find((m) => m.member === `person:${me}`)?.role;
  const fresh = `/?in=${encodeURIComponent(space._id)}`;
  const archived = !!space.archived;
  const invite = manage && !personal && !archived;
  const acts: MenuItem[] = personal ? [] : [
    ...(manage
      ? [
        { label: "Rename", icon: "pencil" as const, onSelect: () => setRenaming(true) },
        archived
          ? {
            label: "Restore",
            icon: "restore" as const,
            onSelect: () => void call("space.archive", { space: space._id, archived: false }),
          }
          : {
            label: "Archive…",
            icon: "archive" as const,
            onSelect: () => openPalette(archiveStep(space, call)),
          },
      ]
      : []),
    ...(role
      ? [{
        label: "Leave…",
        icon: "signout" as const,
        tone: "destructive" as const,
        onSelect: () => openPalette(leaveStep(space, call)),
      }]
      : []),
  ];
  const more: (MenuItem | "separator")[] = personal ? [] : [
    ...acts,
    ...(acts.length ? ["separator" as const] : []),
    { label: "Settings", icon: "settings", href: spacePath(space._id, "settings") },
  ];
  return (
    <Page
      className="space-page"
      width="lg"
      leading={personal
        ? (
          <span className="space-mark space-mark-personal">
            <Icon name="person" size={22} />
          </span>
        )
        : <Avatar name={space.name} kind="space" size={44} className="space-mark" />}
      title={renaming
        ? (
          <InlineEdit
            label="The space's name"
            value={space.name}
            maxLength={60}
            size="lg"
            save={(next) => call("space.rename", { space: space._id, name: next })}
            done={() => setRenaming(false)}
          />
        )
        : name}
      badges={renaming ? null : (
        <>
          {manage && !personal
            ? (
              <IconButton
                icon="pencil"
                label="Rename the space"
                size="sm"
                className="space-rename"
                onClick={() => setRenaming(true)}
              />
            )
            : null}
          {personal
            ? <Badge>Just you</Badge>
            : archived
            ? <Badge tone="warning">Archived</Badge>
            : <Badge tone="primary">Shared</Badge>}
          {!personal && role ? <Badge variant="outline">{roleName(role)}</Badge> : null}
        </>
      )}
      description={personal
        ? "Yours alone, with your agents. To work with others, make a shared space."
        : together(people.length, agents)}
      actions={
        <>
          {!personal && people.length
            ? (
              <a
                className="space-faces"
                href={`/space/${encodeURIComponent(space._id)}?tab=members`}
                aria-label={`Members: ${people.map((p) => whoOf(p.member).id).join(", ")}`}
              >
                {people.slice(0, FACES).map((p) => {
                  const id = whoOf(p.member).id;
                  return <Avatar key={p._id} name={id} size={28} title={id} />;
                })}
                {people.length > FACES
                  ? <Badge className="space-faces-more">+{people.length - FACES}</Badge>
                  : null}
              </a>
            )
            : null}
          {invite
            ? (
              <>
                <Button
                  icon="invite"
                  className="space-wide"
                  onClick={() => setInviting(true)}
                >
                  Invite
                </Button>
                <IconButton
                  icon="invite"
                  label="Invite someone"
                  variant="outline"
                  className="space-narrow"
                  onClick={() => setInviting(true)}
                />
              </>
            )
            : null}
          <Button variant="primary" icon="compose" href={fresh} className="space-wide">
            New chat
          </Button>
          <IconButton
            icon="compose"
            label="New chat here"
            variant="primary"
            href={fresh}
            className="space-narrow"
          />
          {more.length
            ? <Menu label={`${spaceName(space)}: more`} items={more} align="end" />
            : null}
        </>
      }
    >
      {children}
      {invite
        ? <InviteDialog open={inviting} onClose={() => setInviting(false)} space={space} />
        : null}
    </Page>
  );
}
