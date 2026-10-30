/**
 * Agents as team's web front end makes them: each by what it's shown as
 * (the name people gave it, "Maya"; one of the app's, by what it's called)
 * with its emoji; what `agent.options` answers; the name a new one is
 * called by (`Maya` is `@maya`, as `agent.create` makes it); finding one
 * among those someone knows; what a new one starts with (the app's usual
 * agent's tools, an emoji to pick); and names in a sentence.
 */
import { type Agent, SEND } from "../../../chat/contract.ts";

/** What `agent.options` answers: what an agent can be made with. */
export type Options = { tools: { name: string; description: string }[]; models: string[] };

/** How an agent shows: its name, and its emoji if it has one. */
export type Shown = { name: string; icon?: string };

/** How agent `id` shows: by its name, or its id when it has none (the app's). */
export const shownAs = (id: string, agent?: Pick<Agent, "name" | "icon">): Shown => ({
  name: agent?.name || id,
  ...(agent?.icon ? { icon: agent.icon } : {}),
});

/** An agent's page; `edit`, open to change it. */
export const agentPath = (id: string, edit = false) =>
  `/agent/${encodeURIComponent(id)}${edit ? "?edit=1" : ""}`;

/** Text as it's matched: any case, any accents. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * What a new agent named `name` is called by, as `agent.create` makes it
 * ("Maya Lima" is `maya-lima`), or the next one free when it's `taken`
 * (`maya-2`).
 */
export function handleOf(name: string, taken: (id: string) => boolean = () => false): string {
  const base = fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) ||
    "agent";
  for (let n = 1;; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!taken(handle)) return handle;
  }
}

/** The agents what's typed finds: every word in its name, what it's called by, or what it does. */
export function found<A extends { id: string; name: string; description?: string }>(
  agents: A[],
  typed: string,
): A[] {
  const words = fold(typed.replace(/@/g, " ")).split(/\s+/).filter(Boolean);
  return agents.filter((a) => {
    const text = fold(`${a.name} ${a.id} ${a.description ?? ""}`);
    return words.every((w) => text.includes(w));
  });
}

/**
 * The tools a new agent starts with: those the app's usual agent has (its
 * default one, or its first) that an agent may be given; without any,
 * messaging others.
 */
export function usualTools(known: Record<string, Agent>, offered: string[]): string[] {
  const app = Object.values(known).filter((agent) => !agent.in);
  const usual = app.find((agent) => agent.default) ?? app[0];
  const tools = (usual?.tools ?? []).filter((tool) => offered.includes(tool));
  return tools.length ? tools : offered.filter((tool) => tool === SEND);
}

/** Emoji a new agent may be shown with, a few to pick from. */
export const ICONS = ["✨", "🧭", "🔎", "✍️", "📊", "🧠", "🛠️", "🎨", "📅", "🧪", "📚", "🦉"];

/** Names as a sentence says them: "a", "a and b", "a, b and c". */
export const listed = (items: string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
