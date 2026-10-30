/**
 * Chats as lists show them (`thread.recent`'s answers): what each is called
 * (its title, else what was said first, else last), whether it matches what
 * was searched, and grouped by when they were last written in: today,
 * yesterday, this week, this month, then by month.
 */
import type { Thread } from "../../collections/thread.ts";
import { plain } from "./plain.ts";

/** A chat as `thread.recent` lists it: how many messages, what was said first and last. */
export type Listed = Thread & { messages: number; first?: string; last?: string };

const line = (text?: string) => plain(text) || undefined;

/** What a chat is called in a list. */
export const titleOf = (t: Listed): string =>
  line(t.title) ?? line(t.first) ?? line(t.last) ?? "New chat";

/** What was said last, when it says more than the title. */
export const lastOf = (t: Listed): string | undefined => {
  const last = line(t.last);
  return last && last !== titleOf(t) ? last : undefined;
};

/** Whether a chat has every word searched for (any case, any accents), in what it's called or said. */
export function matches(t: Listed, search: string): boolean {
  const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const said = fold([t.title, t.first, t.last].filter(Boolean).join(" "));
  return words.every((word) => said.includes(word));
}

export type Group = { label: string; items: Listed[] };

const DAY = 86_400_000;

/** Chats by when they were last written in, newest first, as headings say it. */
export function byDay(threads: Listed[], now = new Date()): Group[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const labelOf = (at: string) => {
    const time = Date.parse(at);
    if (Number.isNaN(time)) return "Earlier";
    if (time >= midnight) return "Today";
    if (time >= midnight - DAY) return "Yesterday";
    if (time >= midnight - 6 * DAY) return "This week";
    const date = new Date(time);
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
      return "This month";
    }
    return date.toLocaleDateString("en", {
      month: "long",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
  };
  const groups: Group[] = [];
  const time = (t: Listed) => Date.parse(t.at) || 0;
  for (const t of [...threads].sort((a, b) => time(b) - time(a))) {
    const label = labelOf(t.at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(t);
    else groups.push({ label, items: [t] });
  }
  return groups;
}
