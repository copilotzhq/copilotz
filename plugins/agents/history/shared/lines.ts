/** Summary nodes' ids, sizes in bytes, and messages as one line of text. */
import type { Message, Thread } from "../../chat/contract.ts";

/** A thread whose older history is summarized says so, so others never look for an outline. */
export type Outlined = Thread & { outlined?: boolean };

export const node = (thread: string, level: number, index: number) => `${thread}:${level}:${index}`;
const encoder = new TextEncoder();
export const size = (text: string) => encoder.encode(text).length;

/** A message as one piece of text: who wrote it, to whom, and what. */
export const lineOf = (m: Pick<Message, "from" | "to" | "text">) =>
  `${m.from}${m.to.length ? ` → ${m.to.join(", ")}` : ""}: ${m.text ?? ""}`;

/** Cuts text to at most `limit` UTF-8 bytes, on a character boundary. */
export function cut(text: string, limit: number) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit)).replace(/�$/, "");
}
