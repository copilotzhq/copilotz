/**
 * What documents hold and how they read in a few words: the most a text may
 * be, its size, who someone is from the actor doing something (`person:ana`,
 * `agent:north`), a document's address, and its first lines as plain text.
 */
import type { Actor } from "../../../../runtime/mod.ts";

/** `T` without `K`, nor the index signature a schema's type has (its fields stay). */
export type Without<T, K extends string> = {
  [P in keyof T as string extends P ? never : number extends P ? never : P extends K ? never : P]:
    T[P];
};

/** The most a document's text may be, in bytes of UTF-8: 100 KB. */
export const LIMIT = 100 * 1024;

/** The most a title may be, in characters. */
export const TITLE = 200;

/** What a new document is called until someone names it. */
export const UNTITLED = "Untitled";

const encoder = new TextEncoder();

/** A text's size, in bytes of UTF-8. */
export const sizeOf = (text: string) => encoder.encode(text).length;

/** Who did it, as a member of a space is keyed: `person:ana`, `agent:north`. */
export const keyOf = (actor: Pick<Actor, "kind" | "id">) => `${actor.kind}:${actor.id}`;

/** The person an agent works for, from its actor, if it says. */
export function forOf(actor: Actor | undefined): string | undefined {
  const person = actor?.for as Actor | undefined;
  return person && typeof person === "object" && typeof person.id === "string"
    ? keyOf(person)
    : undefined;
}

/** A document's page (where the person is, `in`, if known). */
export const documentPath = (id: string, space?: string) =>
  `/document/${encodeURIComponent(id)}${space ? `?in=${encodeURIComponent(space)}` : ""}`;

/** A version's `_id`: `<document>:<version>`. */
export const versionId = (document: string, version: number) => `${document}:${version}`;

/** A space's Documents tab. */
export const documentsTab = (space: string) => `/space/${encodeURIComponent(space)}?tab=documents`;

/** A line of Markdown as plain words: no heading marks, emphasis, list marks or link targets. */
const plain = (line: string) =>
  line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`+)/g, "")
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, "$1$2")
    .trim();

/**
 * How a document opens, as plain text (`most` characters at most): its first
 * lines that say something, headings left out (they're its outline), lines
 * that don't end a sentence kept apart with a dot (a list's items).
 */
export function excerptOf(text: string, title = "", most = 220): string {
  const said: string[] = [];
  const headings: string[] = [];
  let length = 0;
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*([-*_]\s*){3,}$/.test(raw) || /^\s*\|?\s*:?-{3,}/.test(raw)) continue;
    const line = plain(raw.replace(/\|/g, " "));
    if (!line) continue;
    if (/^\s{0,3}#{1,6}\s/.test(raw)) {
      if (line.toLowerCase() !== title.trim().toLowerCase()) headings.push(line);
      continue;
    }
    said.push(line);
    length += line.length + 3;
    if (length > most) break;
  }
  const lines = said.length ? said : headings;
  const flat = lines.reduce(
    (all, line) => !all ? line : /[.!?:;,…]$/.test(all) ? `${all} ${line}` : `${all} · ${line}`,
    "",
  ).replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
}

/** "2.1 KB", for a size in bytes. */
export const kb = (bytes: number) =>
  bytes < 1000 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
