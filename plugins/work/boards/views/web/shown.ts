/**
 * Boards as their web front end says them, pure (so tested): a label's hue
 * (the same label is the same colour everywhere), a due date against today
 * (overdue, today, soon), who someone is (people by their profiles' names,
 * agents by the name they're shown as, with their emoji), what a filter keeps, and
 * a board's cards by column, with moves still on their way shown where
 * they're going.
 */
import { nameOf } from "../../../../access/spaces/contract.ts";
import type { Board, Card, Column } from "../../contract.ts";
import { fold, stageOf } from "../../shared/columns.ts";
import { daysUntil } from "../../shared/dates.ts";
import { byOrder } from "../../shared/order.ts";

/** How many hues labels take (see style.ts: `--board-hue-0` … `-7`). */
export const HUES = 8;

/** A label's hue: from its letters, so it's the same wherever it shows. */
export function hueOf(label: string): number {
  let h = 0;
  for (const c of label.trim().toLowerCase()) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h % HUES;
}

/** A due date as a card shows it: its words, how pressing it is, and the date in full. */
export type DueShown = {
  text: string;
  tone: "overdue" | "today" | "soon" | "later" | "done";
  title: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 2", or "Nov 2, 2027" in another year than `today`'s. */
export function dayOf(due: string, today: string): string {
  const [y, m, d] = due.split("-").map(Number);
  const year = Number(today.slice(0, 4));
  return `${MONTHS[m - 1]} ${d}${y !== year ? `, ${y}` : ""}`;
}

export function dueShown(due: string, today: string, done = false): DueShown {
  const days = daysUntil(due, today);
  const day = dayOf(due, today);
  const title = days === 0
    ? "Due today"
    : days > 0
    ? `Due in ${days} day${days === 1 ? "" : "s"}`
    : `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (done) return { text: day, tone: "done", title: `Was due ${day}` };
  if (days < 0) {
    return { text: `Overdue · ${days === -1 ? "yesterday" : day}`, tone: "overdue", title };
  }
  if (days === 0) return { text: "Today", tone: "today", title };
  if (days === 1) return { text: "Tomorrow", tone: "soon", title };
  return { text: day, tone: days <= 3 ? "soon" : "later", title };
}

/** Someone a card can go to: their key, name, and an agent's emoji. */
export type Someone = {
  key: string;
  kind: "person" | "agent";
  name: string;
  icon?: string;
  /** A quieter line: a person's email, an agent's role. */
  note?: string;
};

/** What chat's `thread.agents` says of agents: how each shows. */
export type Team = {
  here: string[];
  default: string[];
  agents: Record<string, { name?: string; icon?: string; description?: string }>;
};

/** Names by person id, as their profiles say them (Copilotz's `namesIn`). */
export type Names = Record<string, string>;

/**
 * A person's id as a name: their profile's; else an email's first part, or
 * the id itself when it reads as a name (a sign-in's id never does).
 */
export const personName = (id: string, names: Names = {}) =>
  names[id] ?? (/^[^:@\s]+@/.test(id) ? id.split("@")[0] : nameOf(id, names));

/** Who `key` (`person:ana`, `agent:north`) is, as shown. */
export function someoneOf(key: string, team?: Team, me?: string, names?: Names): Someone {
  const at = key.indexOf(":");
  const kind = key.slice(0, at) === "agent" ? "agent" : "person";
  const id = key.slice(at + 1);
  if (kind === "agent") {
    const agent = team?.agents[id];
    return {
      key,
      kind,
      name: agent?.name || id,
      ...(agent?.icon ? { icon: agent.icon } : {}),
    };
  }
  const name = personName(id, names);
  return {
    key,
    kind,
    name: id === me ? `${name} (you)` : name,
    ...(/^[^:@\s]+@/.test(id) ? { note: id } : {}),
  };
}

/**
 * Who cards here can go to: the space's people (you first) then its agents,
 * by name; and anyone a card already has who's no longer there, kept.
 */
export function peopleOf(
  members: { member: string }[],
  team: Team | undefined,
  me?: string,
  also: string[] = [],
  names?: Names,
): Someone[] {
  const keys = [...new Set([...members.map((m) => m.member), ...also])]
    .filter((k) => k.startsWith("person:") || k.startsWith("agent:"));
  const all = keys.map((k) => someoneOf(k, team, me, names));
  const rank = (s: Someone) => s.kind === "person" ? (s.key === `person:${me}` ? 0 : 1) : 2;
  return all.sort((a, b) =>
    rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** What the board is filtered by: words, owners (`none` for nobody), labels. */
export type Filters = { search: string; assignees: string[]; labels: string[] };

export const NO_FILTERS: Filters = { search: "", assignees: [], labels: [] };

export const filtering = (f: Filters) =>
  !!f.search.trim() || f.assignees.length > 0 || f.labels.length > 0;

/** Whether a card shows under the filters: every word in it, one of the owners, one of the labels. */
export function kept(card: Card, f: Filters, names: (key: string) => string = (k) => k): boolean {
  if (f.assignees.length && !f.assignees.includes(card.assignee ?? "none")) return false;
  if (
    f.labels.length &&
    !card.labels?.some((l) => f.labels.some((wanted) => fold(wanted) === fold(l)))
  ) return false;
  const words = fold(f.search).split(" ").filter(Boolean);
  if (!words.length) return true;
  const text = fold(
    [
      card.title,
      card.description ?? "",
      ...(card.labels ?? []),
      card.assignee ? names(card.assignee) : "",
    ]
      .join(" "),
  );
  return words.every((w) => text.includes(w));
}

/** Every label on a board's cards, once each (as first written), most used first. */
export function labelsOn(cards: Card[]): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const card of cards) {
    for (const label of card.labels ?? []) {
      const key = fold(label);
      const seen = counts.get(key);
      if (seen) seen.count++;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** A move on its way: where a card is going, until the board says it's there. */
export type Pending = Record<string, { column: string; order: number }>;

/** A board's cards by column, in order, with pending moves applied (cards of no column, last). */
export function byColumn(board: Board, cards: Card[], pending: Pending = {}): Map<string, Card[]> {
  const placed = cards.map((c) => pending[c._id] ? { ...c, ...pending[c._id] } : c);
  const columns = new Map<string, Card[]>(board.columns.map((c) => [c.id, []]));
  for (const card of byOrder(placed)) {
    (columns.get(card.column) ?? columns.get(board.columns[0]?.id ?? "") ?? []).push(card);
  }
  return columns;
}

/** Whether a column's cards are done: there, a past due date isn't overdue. */
export const isDone = (column: Column) => stageOf(column) === "done";

/** A Markdown description, as a card's mark says it: whether it says anything. */
export const says = (card: Pick<Card, "description">) => !!card.description?.trim();

/** A board's card count, as words: "1 card", "12 cards". */
export const counted = (n: number, one = "card", many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
