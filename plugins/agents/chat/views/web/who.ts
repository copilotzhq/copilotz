/**
 * Who wrote a message, as the web shows it (agents and people look
 * different), names in a sentence, and what home greets someone as.
 */
import type { Message } from "../../collections/message.ts";

/** An agent wrote it: its turn did (a reply, a step), or it's a hop from one (what it sent). */
export const byAgent = (m: Message): boolean =>
  m.turn !== undefined || (m.hops ?? 0) > 0 || m.toolCalls !== undefined;

/** Names as a sentence says them: "ana", "ana and bob", "ana, bob and cy". */
export const names = (list: string[]): string =>
  list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

/**
 * What home greets someone as: their first name, capitalised; signed in by
 * email, its first part, up to a dot ("ana.lima@example.com" is "Ana"). An
 * id that isn't a name ("google:1234") greets no one by name.
 */
export const greeted = (name: string): string => {
  if (/^[a-z]+:/.test(name)) return "";
  const first = name.split("@")[0].split(/[\s._+-]/).find(Boolean) ?? "";
  return first ? first[0].toLocaleUpperCase() + first.slice(1) : "";
};
