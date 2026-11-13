/**
 * A conversation on the web (kind `thread`): its header, what was said
 * (subthreads' messages beside its own), what agents are writing right now,
 * and where you type. Each message and each reply being written is a part
 * of its own: a token redraws its reply alone. Messages from one author in a
 * row group under one name; questions an agent waits on you for say so.
 * Over where you type, what other front ends put there (the `conversation`
 * resource: a View each, with hints `{ thread, in, working }`), such as an
 * agent waiting on your OK once its turn is over. Its header's menu moves it
 * to another space (the command palette's space picker), as the palette
 * does. Agents show as they're named (Maya, with her emoji), wherever they
 * wrote, are written to or work, and `@` lists those answering in the
 * chat's space: `thread.agents`. A message refused for a reason another
 * front end helps with (the `refusals` resource: `not_here`, spaces') shows
 * that front end's View over where you type, as does what they want known
 * before sending (`composerNotes`). A message of yours waiting for an agent
 * still at work on an earlier one says so (see queued.tsx).
 *
 * A chat shared with someone outside its space (a contact, a member of the
 * chat alone: `thread:<id>`) has staff notes beside it, its team's alone
 * (see notes-lane.tsx and notes.tsx): the header's button opens them (a
 * switch on a phone), its box says who it's shared with, and naming an
 * agent there offers to ask in the notes instead. Notes opened as a page
 * say what they're about, and their messages' words can go on to the chat.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Icon } from "../../../../../hosts/web/mod.ts";
import type { Live } from "../../collections/live.ts";
import type { Message } from "../../collections/message.ts";
import type { Thread } from "../../collections/thread.ts";
import type { Team } from "../../shared/agents.ts";
import { notesOf } from "../../shared/notes.ts";
import type { ComposerNote, ConversationView, RefusalView } from "../../shared/types.ts";
import { mentionable, shownAll } from "./agents.ts";
import { Composer, type Mentioned } from "./composer.tsx";
import { Header, type Someone } from "./header.tsx";
import { Missing } from "./missing.tsx";
import {
  type Lane,
  MentionHint,
  NotesBanner,
  NotesSwitch,
  NotesToggle,
  OnlyTeam,
  pathOf,
  WithNotes,
} from "./notes-lane.tsx";
import { threadTitle } from "./listed.ts";
import { Over } from "./over.tsx";
import { plain } from "./plain.ts";
import type { SendTo } from "./send-on.tsx";
import { STYLE } from "./style.ts";
import { Transcript } from "./transcript.tsx";
import { waitingOn } from "./waiting.ts";
import { byAgent, names } from "./who.ts";
import { say } from "./words.ts";
import { nameOf, namesIn, picturesIn } from "../../../../access/spaces/contract.ts";
import { DELEGATED } from "../../shared/types.ts";

/** Messages this close after the one before, from the same author, go under its name. */
const GROUP_MS = 5 * 60_000;

type Space = { _id: string; name: string; kind: string };

export const conversationView = (t: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  if (!t._id) return ctx.show("home", {}, ctx.hints);
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const me = ctx.viewer?.name ?? "";
  // Undefined while it's read; null when it isn't there, or isn't theirs to see.
  const thread = ctx.db.collection<Thread>("thread").findOne({ _id: t._id }).value;
  const fresh = here ? `/?in=${encodeURIComponent(here)}` : "/";
  if (thread === undefined) return <section className="chat" aria-busy="true" />;
  if (thread === null) {
    return (
      <>
        <style href="chat-web" precedence="copilotz">{STYLE}</style>
        <Missing fresh={fresh} />
      </>
    );
  }
  // Who's outside its space: this chat's, or, for notes, the chat's they're about.
  const outside = outsideIn(ctx, thread.about ?? t._id);
  const shared = !!outside && !thread.about;
  const notesId = notesOf(t._id);
  const notes = shared
    ? ctx.db.collection<Thread>("thread").findOne({ _id: notesId }).value
    : undefined;
  const lane: Lane | undefined = shared
    ? {
      chat: t._id,
      name: outside.name,
      ...(thread.in ? { in: thread.in } : {}),
      ...(notes ? { notes: notes._id } : {}),
    }
    : undefined;
  const { main, title, people, space } = talk(ctx, {
    id: t._id,
    thread,
    ...(thread.about
      ? {
        placeholder: say("notesPlaceholder"),
        note: <OnlyTeam />,
        ...(outside ? { sendTo: outside } : {}),
      }
      : {}),
    ...(shared
      ? {
        note: (
          <span className="chat-shared">
            <Icon name="eye" size={13} />
            {say("sharedWith", { name: outside.name })}
          </span>
        ),
        mentionNote: (typed: Mentioned) => (
          <MentionHint who={me} notes={notesId} name={outside.name} typed={typed} />
        ),
      }
      : {}),
  });

  return (
    <section className="chat" aria-label={say("conversation")}>
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <Header
        title={title.length > 90 ? `${title.slice(0, 88)}…` : title}
        thread={t._id}
        space={space}
        people={people}
        fresh={fresh}
        call={ctx.call}
        tools={lane ? <NotesToggle who={me} count={notes?.messages} /> : undefined}
      />
      {thread.about
        ? (
          <NotesBanner
            name={outside?.name ?? say("yourContact")}
            href={pathOf(thread.about, thread.in)}
          />
        )
        : null}
      {lane ? <NotesSwitch who={me} count={notes?.messages} /> : null}
      <WithNotes who={me} lane={lane}>{main}</WithNotes>
    </section>
  );
};

/**
 * Who a chat is shared with outside its space (its members: contacts, or
 * people let into it alone), as the viewer reads them: as a sentence names
 * them, and how a message is addressed to them there (`to`); undefined when
 * it's shared with nobody outside.
 */
export function outsideIn(ctx: ViewContext<ReactNode>, chat: string): SendTo | undefined {
  const members = (ctx.db.collection<{ member: string }>("member")
    .find({ space: `thread:${chat}` }).value ?? [])
    .map((m) => m.member)
    .filter((id) => id.startsWith("contact:") || id.startsWith("person:"));
  if (!members.length) return undefined;
  const known = namesIn(ctx, members);
  // A contact with no name yet is "your contact"; a person shows by their id at least.
  const named = members.flatMap((id) =>
    known[id] ?? (id.startsWith("person:") ? [nameOf(id, known)] : [])
  );
  return {
    thread: chat,
    to: members.map((id) => id.startsWith("person:") ? id.slice("person:".length) : id),
    name: named.length ? names(named) : say("yourContact"),
  };
}

/** What a conversation shows under its header, for its page and for its notes' lane. */
export type Talk = {
  id: string;
  /** Its document; null for notes not made yet. */
  thread: Thread | null;
  /** Its space, until there's a document to say (the chat's, for its notes). */
  in?: string;
  placeholder?: string;
  /** Where its messages' words may go on to (notes': the chat, for its contact). */
  sendTo?: SendTo;
  /** A line under where you type. */
  note?: ReactNode;
  /** Over where you type, while what's typed names agents (see `Composer`). */
  mentionNote?(typed: Mentioned): ReactNode;
  /** In place of what was said, while there's no document (notes not made yet). */
  empty?: ReactNode;
  /** The conversation to send to, made first when it isn't yet (notes, on first use). */
  made?(): Promise<string>;
  /** Whether where you type takes the keys once shown (see `Composer`). */
  autoFocus?: boolean | (() => boolean);
};

/**
 * What was said, what's being written, what's asked, and where you type,
 * as one conversation's page and a chat's notes both show them: in that
 * order, so where you type stays the same while a document appears (notes
 * made by their first message), and what's typed there stays. With what
 * the header says: the conversation's title, who's in it, and its space.
 */
export function talk(
  ctx: ViewContext<ReactNode>,
  o: Talk,
): { main: ReactNode; title: string; people: Someone[]; space?: Space } {
  const me = ctx.viewer?.name ?? "";
  const { id, thread } = o;
  const within = thread?.in ?? o.in;
  const said = thread
    ? ctx.db.collection<Message>("message").query<Message[]>("conversation", {
      thread: id,
      limit: 120,
    }).value ?? []
    : [];
  const subthreads = said.flatMap((m) => m.subthread ? [m.subthread] : []);
  const live = thread
    ? ctx.db.collection<Live>("live").find({ thread: { $in: [id, ...subthreads] } }, {
      sort: { at: 1 },
    }).value ?? []
    : [];
  const asked = new Set(
    (ctx.db.collection<Message>("message").query<Message[]>("questions", { person: me }).value ??
      []).map((m) => m._id),
  );
  const space = within
    ? ctx.db.collection<Space>("space").findOne({ _id: within }).value ?? undefined
    : undefined;
  // Who answers in its space, and what each is.
  const team = ctx.db.collection("thread").query<Team>("agents", within ? { in: within } : {})
    .value;

  const working = [...new Set(live.map((l) => l.agent))];
  const everyone = [...thread?.agents ?? [], ...said.flatMap((m) => [m.from, ...m.to])];
  // What agents not answering there are, asked for only when there are some (one gone, one asked).
  const others = [
    ...new Set([
      ...thread?.agents ?? [],
      ...said.filter(byAgent).map((m) => m.from),
      ...said.flatMap((m) => m.to),
      ...working,
    ]),
  ].filter((name) => name !== me && team && !team.agents[name]).sort();
  const more = others.length
    ? ctx.db.collection("thread").query<Team>("agents", { names: others }).value
    : undefined;
  const met = { ...more?.agents, ...team?.agents };
  // How each agent here shows: its name and emoji.
  const who = shownAll([...everyone, ...working], met);
  const agents = new Set([
    ...thread?.agents ?? [],
    ...said.filter(byAgent).map((m) => m.from),
    ...Object.keys(who),
  ]);
  // People by name (agents are by theirs): every message shows them so.
  const humans = [...new Set(everyone)].filter((name) => !agents.has(name));
  const known = namesIn(ctx, humans);
  const faces = picturesIn(ctx, humans);
  const shown = {
    ...Object.fromEntries(humans.map((name) => [name, { name: nameOf(name, known) }])),
    ...who,
  };
  const people: Someone[] = [...new Set(everyone)]
    .map((name) => ({
      name: shown[name]?.name ?? name,
      agent: agents.has(name),
      ...(who[name]?.icon ? { icon: who[name].icon } : {}),
      ...(faces[name] ? { picture: faces[name] } : {}),
    }))
    .sort((a, b) => Number(a.agent) - Number(b.agent));
  // What a message says: its words, or a voice message's transcript.
  const words = (m: Message) => m.text || m.files?.find((f) => f.transcript)?.transcript;
  const own = said.filter((m) => m.thread === id && !m.private && words(m));
  const first = own.find((m) => !byAgent(m)) ?? own[0];
  const title = (thread && threadTitle(thread)) || plain(first && words(first)) ||
    say("newChat");
  const last = said[said.length - 1];
  const addressed = thread?.agents?.length
    ? say("messageAgents", { names: names(thread.agents.map((name) => who[name]?.name ?? name)) })
    : say("messageTheAgents");
  // What other front ends show here, over where you type.
  const over = thread
    ? Object.values((ctx.resources.conversation ?? {}) as Record<string, ConversationView>)
      .filter((entry) => entry?.view)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [];
  const made = o.made ?? (() => Promise.resolve(id));

  const main = (
    <>
      {thread || o.empty === undefined
        ? (
          <Transcript last={last?._id} mine={last?.from === me}>
            {said.map((m, i) => {
              const before = said[i - 1];
              // Yours, while an agent it's to finishes an earlier one: it waits its turn.
              const queued = m.from === me && !byAgent(m) ? waitingOn(m, live, said) : [];
              // What's handed between spaces stands apart, or an agent's hand-off and answer read as one.
              const follows = !!before && before.from === m.from && before.thread === m.thread &&
                !before.failed && before.via?.kind !== DELEGATED && m.via?.kind !== DELEGATED &&
                Date.parse(m.at) - Date.parse(before.at) < GROUP_MS;
              return ctx.show("web.message", m, {
                thread: id,
                who: shown,
                usual: thread?.agents ?? [],
                ...(follows ? { follows: true } : {}),
                ...(asked.has(m._id) ? { asked: true } : {}),
                ...(queued.length ? { queued } : {}),
                ...(o.sendTo ? { sendTo: o.sendTo } : {}),
              });
            })}
            {live.map((l) => ctx.show("web.live", l, { thread: id, who }))}
          </Transcript>
        )
        : o.empty}
      {over.length
        ? (
          <div className="chat-asks">
            <Over
              entries={over}
              thread={id}
              space={within}
              side={subthreads}
              live={working}
            />
          </div>
        )
        : null}
      <Composer
        attach={async (file) =>
          ctx.call<{ id: string }>("chat.attach", { ...file, thread: await made() })}
        send={async (text, files, options) => {
          await ctx.call("chat.send", {
            thread: await made(),
            ...(text ? { text } : {}),
            ...(files.length ? { files } : {}),
            ...options,
          });
        }}
        working={working.map((name) => who[name]?.name ?? name)}
        stop={() => ctx.call("chat.stop", { thread: id })}
        placeholder={o.placeholder ?? addressed}
        agents={team ? mentionable(team) : undefined}
        where={space ? space.kind === "personal" ? say("personal") : space.name : undefined}
        refusals={ctx.resources.refusals as Record<string, RefusalView | null> | undefined}
        notes={ctx.resources.composerNotes as Record<string, ComposerNote | null> | undefined}
        place={{ thread: id, ...(within ? { in: within } : {}) }}
        {...(o.note ? { note: o.note } : {})}
        {...(o.mentionNote ? { mentionNote: o.mentionNote } : {})}
        {...(o.autoFocus !== undefined ? { autoFocus: o.autoFocus } : {})}
      />
    </>
  );
  return { main, title, people, ...(space ? { space } : {}) };
}
