/**
 * Staff notes beside a chat shared outside its space (a contact's), as the
 * chat's page shows them: a lane of their own beside the conversation on a
 * wide screen (over it, from the side, on a narrower one), a switch between
 * the two on a phone, and a button in the chat's header saying how many
 * messages they have. The lane says plainly who sees it (the team, never
 * the contact), opens the notes as a page, and reads them (`chat.notes`)
 * only while it's open. Notes opened as a page say what they're about, with
 * the way back. Naming an agent where the contact reads offers to ask in
 * the notes instead, moving what's typed there. Calm, tinted apart: never
 * an alarm.
 */
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  formatNumber,
  Icon,
  IconButton,
  LazyView,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { Mentioned } from "./composer.tsx";
import { handDraft } from "./handed.ts";
import { setNotesOpen, useNotesOpen } from "./lane.ts";
import { names } from "./who.ts";
import { say } from "./words.ts";

/** The one lane on the page, for the buttons that open it to name. */
const LANE = "chat-notes-lane";

/** A chat's notes, as its page knows them before opening the lane. */
export type Lane = {
  /** The chat they're about. */
  chat: string;
  /** Its space. */
  in?: string;
  /** Who it's shared with outside, as a sentence names them ("Ana"). */
  name: string;
  /** The notes, once they're made: their id. */
  notes?: string;
};

/** A conversation's page, in its space. */
export const pathOf = (thread: string, space?: string): string =>
  `/thread/${encodeURIComponent(thread)}${space ? `?in=${encodeURIComponent(space)}` : ""}`;

/** The header's way to the notes: a labelled button, with how many messages they have. */
export function NotesToggle({ who, count }: { who: string; count?: number }): ReactNode {
  const open = useNotesOpen(who);
  return (
    <Button
      size="sm"
      icon="lock"
      className="notes-toggle"
      aria-expanded={open}
      aria-controls={LANE}
      aria-label={count ? say("notesWithCount", { count }) : undefined}
      onClick={() => setNotesOpen(who, !open)}
    >
      {say("notesTitle")}
      {count ? <Badge className="notes-count">{formatNumber(count)}</Badge> : null}
    </Button>
  );
}

/** On a phone, the conversation or its notes: one at a time, the switch always in sight. */
export function NotesSwitch({ who, count }: { who: string; count?: number }): ReactNode {
  const open = useNotesOpen(who);
  return (
    <div className="notes-switch" role="group" aria-label={say("notesViews")}>
      <button type="button" aria-pressed={!open} onClick={() => setNotesOpen(who, false)}>
        <Icon name="chat" size={15} />
        {say("conversation")}
      </button>
      <button
        type="button"
        className="notes-switch-notes"
        aria-pressed={open}
        aria-label={count ? say("notesWithCount", { count }) : undefined}
        onClick={() => setNotesOpen(who, true)}
      >
        <Icon name="lock" size={15} />
        {say("notesTitle")}
        {count ? <Badge className="notes-count">{formatNumber(count)}</Badge> : null}
      </button>
    </div>
  );
}

/** The conversation, and beside it the notes' lane while it's open. */
export function WithNotes(
  { who, lane, children }: { who: string; lane?: Lane; children: ReactNode },
): ReactNode {
  const open = useNotesOpen(who) && !!lane;
  return (
    <div className="chat-split" data-notes={open ? "open" : undefined}>
      <div className="chat-main">{children}</div>
      {open && lane ? <NotesLane who={who} lane={lane} /> : null}
    </div>
  );
}

function NotesLane({ who, lane }: { who: string; lane: Lane }): ReactNode {
  return (
    <aside id={LANE} className="notes-lane" aria-label={say("notesTitle")}>
      <header className="notes-head">
        <span className="notes-mark">
          <Icon name="lock" size={15} />
        </span>
        <div className="notes-head-text">
          <h2>{say("notesTitle")}</h2>
          <p>{say("notesNever", { name: lane.name })}</p>
        </div>
        {lane.notes
          ? (
            <IconButton
              icon="external"
              size="sm"
              label={say("notesAsPage")}
              href={pathOf(lane.notes, lane.in)}
            />
          )
          : null}
        <IconButton
          icon="close"
          size="sm"
          label={say("notesClose")}
          className="notes-close"
          onClick={() => setNotesOpen(who, false)}
        />
      </header>
      <div className="notes-body">
        <LazyView
          kind="chat.notes"
          item={{ _id: lane.chat }}
          hints={lane.in ? { in: lane.in } : {}}
          fallback={<NotesLoading />}
        />
      </div>
    </aside>
  );
}

/** The notes on their way: a few quiet lines where they'll be. */
export function NotesLoading(): ReactNode {
  return (
    <div className="notes-loading" aria-busy="true">
      <Skeleton height={14} width="38%" />
      <Skeleton height={48} width="82%" radius="lg" />
      <Skeleton height={14} width="30%" />
      <Skeleton height={36} width="64%" radius="lg" />
    </div>
  );
}

/** Before the notes are made: what they're for, where the first message goes. */
export function NotesEmpty({ name }: { name: string }): ReactNode {
  return (
    <div className="notes-empty">
      <span className="notes-mark notes-mark-lg">
        <Icon name="lock" size={20} />
      </span>
      <h3>{say("notesEmptyTitle")}</h3>
      <p>{say("notesEmptyBody", { name })}</p>
    </div>
  );
}

/** Under where you type in the notes: who reads what's sent there. */
export function OnlyTeam(): ReactNode {
  return (
    <span className="notes-hint">
      <Icon name="lock" size={12} />
      {say("notesOnlyTeam")}
    </span>
  );
}

/** Over notes opened as a page: what they're about, that only the team sees them, and the way back. */
export function NotesBanner({ name, href }: { name: string; href: string }): ReactNode {
  return (
    <div className="notes-banner" role="note">
      <span className="notes-mark">
        <Icon name="lock" size={14} />
      </span>
      <p>
        <b>{say("notesAbout", { name })}</b>
        <span className="notes-banner-only">{say("notesOnlyTeam")}</span>
      </p>
      <Button size="sm" iconEnd="chevron" href={href}>{say("openConversation")}</Button>
    </div>
  );
}

/**
 * Over a contact's chat's box, once what's typed names its agents: they'd
 * answer where the contact reads; asking in the notes moves it there.
 */
export function MentionHint(
  { who, notes, name, typed }: { who: string; notes: string; name: string; typed: Mentioned },
): ReactNode {
  return (
    <Notice
      tone="neutral"
      icon="eye"
      className="chat-mention-note"
      action={
        <Button
          size="sm"
          icon="lock"
          onClick={() => {
            handDraft(notes, typed.text);
            typed.clear();
            setNotesOpen(who, true);
          }}
        >
          {say("askInNotes")}
        </Button>
      }
    >
      {say("answersWhereSeen", { agents: names(typed.agents.map((a) => a.name)), name })}
    </Notice>
  );
}
