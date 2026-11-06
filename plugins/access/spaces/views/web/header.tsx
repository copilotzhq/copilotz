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
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** At most this many faces show; the rest are counted. */
const FACES = 5;

/** Who works in a shared space, in words: "3 people and 2 agents work here." */
const together = (people: number, agents: number) =>
  agents
    ? say("workBoth", {
      people: say("peopleCount", { count: people }),
      agents: say("agentsCount", { count: agents }),
    })
    : say("workPeopleOnly", { count: people });

export function SpaceHeader(
  { space, members, manage, me, call, children, names = {} }: {
    space: Reached;
    members: Member[];
    manage: boolean;
    me?: string;
    call: Call;
    children: ReactNode;
    /** People by name (`namesIn`): its members, whose it is. */
    names?: Record<string, string>;
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const personal = space.kind === "personal";
  const name = spaceName(space, me, names);
  const people = peopleIn(members);
  const agents = members.filter((m) => whoOf(m.member).kind === "agent").length;
  const role = members.find((m) => m.member === `person:${me}`)?.role;
  const fresh = `/?in=${encodeURIComponent(space._id)}`;
  const archived = !!space.archived;
  const invite = manage && !personal && !archived;
  const acts: MenuItem[] = personal ? [] : [
    ...(manage
      ? [
        { label: say("rename"), icon: "pencil" as const, onSelect: () => setRenaming(true) },
        archived
          ? {
            label: say("restore"),
            icon: "restore" as const,
            onSelect: () => void call("space.archive", { space: space._id, archived: false }),
          }
          : {
            label: say("archiveMenu"),
            icon: "archive" as const,
            onSelect: () => openPalette(archiveStep(space, call)),
          },
      ]
      : []),
    ...(role
      ? [{
        label: say("leaveMenu"),
        icon: "signout" as const,
        tone: "destructive" as const,
        onSelect: () => openPalette(leaveStep(space, call)),
      }]
      : []),
  ];
  const more: (MenuItem | "separator")[] = personal ? [] : [
    ...acts,
    ...(acts.length ? ["separator" as const] : []),
    { label: say("settings"), icon: "settings", href: spacePath(space._id, "settings") },
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
            label={say("spaceNameLabel")}
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
                label={say("renameSpace")}
                size="sm"
                className="space-rename"
                onClick={() => setRenaming(true)}
              />
            )
            : null}
          {personal
            ? <Badge>{say("justYou")}</Badge>
            : archived
            ? <Badge tone="warning">{say("archived")}</Badge>
            : <Badge tone="primary">{say("shared")}</Badge>}
          {!personal && role ? <Badge variant="outline">{roleName(role)}</Badge> : null}
        </>
      )}
      description={personal ? say("personalAbout") : together(people.length, agents)}
      actions={
        <>
          {!personal && people.length
            ? (
              <a
                className="space-faces"
                href={`/space/${encodeURIComponent(space._id)}?tab=members`}
                aria-label={say("membersNamed", {
                  names: people.map((p) => whoOf(p.member, names).name).join(", "),
                })}
              >
                {people.slice(0, FACES).map((p) => {
                  const { name } = whoOf(p.member, names);
                  return <Avatar key={p._id} name={name} size={28} title={name} />;
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
                  {say("invite")}
                </Button>
                <IconButton
                  icon="invite"
                  label={say("inviteSomeone")}
                  variant="outline"
                  className="space-narrow"
                  onClick={() => setInviting(true)}
                />
              </>
            )
            : null}
          <Button variant="primary" icon="compose" href={fresh} className="space-wide">
            {say("newChat")}
          </Button>
          <IconButton
            icon="compose"
            label={say("newChatHere")}
            variant="primary"
            href={fresh}
            className="space-narrow"
          />
          {more.length ? <Menu label={say("moreOf", { name })} items={more} align="end" /> : null}
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
