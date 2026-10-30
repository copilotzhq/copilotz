/**
 * Agents as chat's web front end shows them: each by what it's shown as
 * (the name people gave it, "Maya"; one of the app's, by what it's called,
 * `researcher`) with its emoji, as `thread.agents` says; the `@name` being
 * typed at the caret, the agents it could be, and putting one there; and
 * which names a message mentioned that don't answer where it went.
 */
import type { Agent } from "../../shared/types.ts";

/** How an agent shows: its name, and its emoji if it has one. */
export type Shown = { name: string; icon?: string };

/** How agent `id` shows: by its name, or its id when it has none (the app's). */
export const shownAs = (id: string, agent?: Pick<Agent, "name" | "icon">): Shown => ({
  name: agent?.name || id,
  ...(agent?.icon ? { icon: agent.icon } : {}),
});

/** Each of `ids` that's an agent in `agents`, as it shows. */
export const shownAll = (
  ids: Iterable<string>,
  agents: Record<string, Agent>,
): Record<string, Shown> =>
  Object.fromEntries(
    [...new Set(ids)].filter((id) => agents[id]).map((id) => [id, shownAs(id, agents[id])]),
  );

/** An agent `@` lists: its id (what's typed), how it shows, and what it does. */
export type Mentionable = { id: string; name: string; icon?: string; description?: string };

/**
 * The agents answering where `team` says (`thread.agents`), as `@` lists
 * them: who answers new chats first, each with how it shows and what it does.
 */
export const mentionable = (
  team: { here: string[]; default: string[]; agents: Record<string, Agent> },
): Mentionable[] =>
  [
    ...team.default.filter((id) => team.here.includes(id)),
    ...team.here.filter((id) => !team.default.includes(id)),
  ].map((id) => ({
    id,
    ...shownAs(id, team.agents[id]),
    ...(team.agents[id]?.description ? { description: team.agents[id].description } : {}),
  }));

/** An agent's page (the address is `/agent/<id>`, whichever front end shows it). */
export const agentPath = (id: string) => `/agent/${encodeURIComponent(id)}`;

/** Text as it's matched: any case, any accents. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** `@name` mentions in a message, in order, once each, as `chat.send` reads them. */
export const mentions = (text: string): string[] => [
  ...new Set([...text.matchAll(/(?:^|\s)@([\w.-]*\w)/g)].map((m) => m[1])),
];

/** The names `text` mentions (`@maya`) that aren't among the agents answering `here`. */
export const unanswered = (text: string, here: string[]): string[] =>
  mentions(text).filter((name) => !here.includes(name));

/** An `@name` being typed: what's typed after the `@`, and where it starts and ends. */
export type Typing = { query: string; start: number; end: number };

/** The `@name` the caret is in, if it's in one: from its `@` to the end of the word. */
export function typingAt(text: string, caret: number): Typing | undefined {
  const typed = /(?:^|\s)@([\w.-]*)$/.exec(text.slice(0, caret));
  if (!typed) return undefined;
  const rest = /^[\w.-]*/.exec(text.slice(caret))![0];
  return { query: typed[1], start: caret - typed[1].length - 1, end: caret + rest.length };
}

/** `text` with the `@name` typed at `at` made `@id`, a space after it, and the caret there. */
export function mention(text: string, at: Typing, id: string): { text: string; caret: number } {
  const after = text.slice(at.end);
  const put = `@${id} `;
  const rest = after.startsWith(" ") ? after.slice(1) : after;
  return { text: text.slice(0, at.start) + put + rest, caret: at.start + put.length };
}

/**
 * The agents `query` could be (what's typed after `@`): those whose id or
 * name starts with it first, then those with a word that does, each in the
 * order given; all of them for nothing typed.
 */
export function matching<A extends { id: string; name: string }>(agents: A[], query: string): A[] {
  const q = fold(query);
  if (!q) return agents;
  const rank = (a: A) => {
    const id = fold(a.id);
    const name = fold(a.name);
    if (id.startsWith(q) || name.startsWith(q)) return 0;
    const words = [...id.split(/[._-]+/), ...name.split(/[\s._-]+/)];
    return words.some((w) => w.startsWith(q)) ? 1 : 2;
  };
  return agents.map((a) => ({ a, r: rank(a) })).filter(({ r }) => r < 2)
    .sort((x, y) => x.r - y.r).map(({ a }) => a);
}
