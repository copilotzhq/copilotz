/** Summary nodes' ids, sizes in bytes, and messages and steps as text. */
import type { LlmMessage } from "../../../models/contract.ts";
import { heldTold, type Message, type Thread } from "../../chat/contract.ts";
import { nameOf } from "../../../access/spaces/contract.ts";

/** A thread whose older history is summarized says so, so others never look for an outline. */
export type Outlined = Thread & { outlined?: boolean };

/** A node's id: in the thread's tree, or (`agent`) in that agent's tree of its steps there. */
export const node = (thread: string, level: number, index: number, agent?: string) =>
  `${thread}:${level}:${index}${agent ? `@${agent}` : ""}`;
const encoder = new TextEncoder();
export const size = (text: string) => encoder.encode(text).length;

/**
 * A message as one piece of text: who wrote it, to whom (people by name,
 * from `names`), what (where a reply went, for one held elsewhere), and the
 * files it came with, by name.
 */
export const lineOf = (
  m: Pick<Message, "from" | "to" | "text" | "files" | "held" | "via">,
  names: Record<string, string> = {},
) => {
  const shown = (who: string) => nameOf(who, names);
  const files = (m.files ?? []).map((f) => ` [file ${f.name}]`).join("");
  const said = m.held ? heldTold(m, m.held.for ? shown(m.held.for) : undefined) : m.text ?? "";
  return `${shown(m.from)}${
    m.to.length ? ` → ${m.to.map(shown).join(", ")}` : ""
  }: ${said}${files}`;
};

/**
 * A step as its agent was sent it, as text: what the agent wrote, then each
 * call with what it returned.
 */
export function stepOf(agent: string, sent: LlmMessage[]): string {
  const results = new Map(
    sent.flatMap((m) => m.role === "tool" ? [[m.toolCallId, m.text] as const] : []),
  );
  return sent.flatMap((m) =>
    m.role !== "assistant" ? [] : [
      ...(m.text ? [`${agent}: ${m.text}`] : []),
      ...(m.toolCalls ?? []).map((c) =>
        `${c.name}(${JSON.stringify(c.input)}) → ${results.get(c.id) ?? ""}`
      ),
    ]
  ).join("\n");
}

/**
 * Text within `limit` UTF-8 bytes: its start and its end, with how much was
 * left out between them.
 */
export function clip(text: string, limit: number) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  const decode = (part: Uint8Array) => new TextDecoder().decode(part).replace(/^�+|�+$/g, "");
  const end = Math.floor(limit / 4);
  const start = limit - end;
  return `${decode(bytes.slice(0, start))}\n[… ${bytes.length - limit} bytes …]\n${
    decode(bytes.slice(bytes.length - end))
  }`;
}

/** Cuts text to at most `limit` UTF-8 bytes, on a character boundary. */
export function cut(text: string, limit: number) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit)).replace(/�$/, "");
}
