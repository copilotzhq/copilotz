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
 * that front end's View over where you type. A message of yours waiting
 * for an agent still at work on an earlier one says so (see queued.tsx).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Live } from "../../collections/live.ts";
import type { Message } from "../../collections/message.ts";
import type { Thread } from "../../collections/thread.ts";
import type { Team } from "../../shared/agents.ts";
import type { ConversationView, RefusalView } from "../../shared/types.ts";
import { mentionable, shownAll } from "./agents.ts";
import { Composer } from "./composer.tsx";
import { Header, type Someone } from "./header.tsx";
import { Missing } from "./missing.tsx";
import { Over } from "./over.tsx";
import { plain } from "./plain.ts";
import { STYLE } from "./style.ts";
import { Transcript } from "./transcript.tsx";
import { waitingOn } from "./waiting.ts";
import { byAgent, names } from "./who.ts";

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
  const said = ctx.db.collection<Message>("message").query<Message[]>("conversation", {
    thread: t._id,
    limit: 120,
  }).value ?? [];
  const subthreads = said.flatMap((m) => m.subthread ? [m.subthread] : []);
  const live = ctx.db.collection<Live>("live").find({ thread: { $in: [t._id, ...subthreads] } }, {
    sort: { at: 1 },
  }).value ?? [];
  const asked = new Set(
    (ctx.db.collection<Message>("message").query<Message[]>("questions", { person: me }).value ??
      []).map((m) => m._id),
  );
  const space = thread.in
    ? ctx.db.collection<Space>("space").findOne({ _id: thread.in }).value
    : undefined;
  // Who answers in its space, and what each is.
  const team = ctx.db.collection("thread").query<Team>("agents", thread.in ? { in: thread.in } : {})
    .value;
  // The spaces messages drew on, by name: read once here, for every message that says so.
  const drawn = [...new Set(said.flatMap((m) => m.sources ?? []))];
  const sources = drawn.length
    ? ctx.db.collection<Space>("space").find({ _id: { $in: drawn } }).value ?? []
    : [];
  const named = (ids: string[]) => ids.map((id) => sources.find((p) => p._id === id)?.name ?? id);

  const working = [...new Set(live.map((l) => l.agent))];
  const everyone = [...thread.agents ?? [], ...said.flatMap((m) => [m.from, ...m.to])];
  // What agents not answering there are, asked for only when there are some (one gone, one asked).
  const others = [
    ...new Set([
      ...thread.agents ?? [],
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
    ...thread.agents ?? [],
    ...said.filter(byAgent).map((m) => m.from),
    ...Object.keys(who),
  ]);
  const people: Someone[] = [...new Set(everyone)]
    .map((name) => ({
      name: who[name]?.name ?? name,
      agent: agents.has(name),
      ...(who[name]?.icon ? { icon: who[name].icon } : {}),
    }))
    .sort((a, b) => Number(a.agent) - Number(b.agent));
  // What a message says: its words, or a voice message's transcript.
  const words = (m: Message) => m.text || m.files?.find((f) => f.transcript)?.transcript;
  const own = said.filter((m) => m.thread === t._id && !m.private && words(m));
  const first = own.find((m) => !byAgent(m)) ?? own[0];
  const title = plain(thread.title ?? (first && words(first))) || "New chat";
  const last = said[said.length - 1];
  const addressed = thread.agents?.length
    ? names(thread.agents.map((id) => who[id]?.name ?? id))
    : "the agents";
  // What other front ends show here, over where you type.
  const over = Object.values((ctx.resources.conversation ?? {}) as Record<string, ConversationView>)
    .filter((entry) => entry?.view)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return (
    <section className="chat" aria-label="Conversation">
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <Header
        title={title.length > 90 ? `${title.slice(0, 88)}…` : title}
        thread={t._id}
        space={space ?? undefined}
        people={people}
        fresh={fresh}
        call={ctx.call}
      />
      <Transcript last={last?._id} mine={last?.from === me}>
        {said.map((m, i) => {
          const before = said[i - 1];
          // Yours, while an agent it's to finishes an earlier one: it waits its turn.
          const queued = m.from === me && !byAgent(m) ? waitingOn(m, live, said) : [];
          const follows = !!before && before.from === m.from && before.thread === m.thread &&
            !before.failed && Date.parse(m.at) - Date.parse(before.at) < GROUP_MS;
          return ctx.show("message", m, {
            thread: t._id,
            who,
            usual: thread.agents ?? [],
            ...(follows ? { follows: true } : {}),
            ...(asked.has(m._id) ? { asked: true } : {}),
            ...(m.sources?.length ? { sources: named(m.sources) } : {}),
            ...(queued.length ? { queued } : {}),
          });
        })}
        {live.map((l) => ctx.show("live", l, { thread: t._id, who }))}
      </Transcript>
      {over.length
        ? (
          <div className="chat-asks">
            <Over entries={over} thread={t._id} space={thread.in} live={working.length > 0} />
          </div>
        )
        : null}
      <Composer
        send={async (text, files, options) => {
          await ctx.call("chat.send", {
            thread: t._id,
            ...(text ? { text } : {}),
            ...(files.length ? { files } : {}),
            ...options,
          });
        }}
        working={working.map((id) => who[id]?.name ?? id)}
        stop={() => ctx.call("chat.stop", { thread: t._id })}
        placeholder={`Message ${addressed}`}
        agents={team ? mentionable(team) : undefined}
        where={space ? space.kind === "personal" ? "Personal" : space.name : undefined}
        refusals={ctx.resources.refusals as Record<string, RefusalView | null> | undefined}
        place={{ thread: t._id, ...(thread.in ? { in: thread.in } : {}) }}
      />
    </section>
  );
};
