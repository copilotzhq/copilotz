/**
 * What a message costs the prompts it's in, in estimated tokens: what an
 * agent is actually sent for it (its `message` View: the text, files' content
 * and transcripts, tool calls and results, what it was told), not just its
 * text. An estimate: about four bytes of text a token; an image as much as
 * a large one costs; a PDF by its pages; a model's state (its thinking, sent
 * back to it) as its adapter says.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { LlmFile, LlmMessage } from "../../../models/contract.ts";
import type { Message } from "../../chat/contract.ts";
import { size } from "./lines.ts";

/** An image, at the most providers charge for one (about 1.15 megapixels). */
export const IMAGE = 1_600;
/** A PDF's page: its text and its picture. */
export const PAGE = 2_000;

/** Text's tokens, about four bytes each. */
export const tokensOf = (text: string) => Math.ceil(size(text) / 4);

/** A PDF's pages, as counted in it; else guessed from its size. */
export function pagesOf(base64: string): number {
  let raw = "";
  try {
    raw = atob(base64);
  } catch { /* not base64: guessed below */ }
  const counted = raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return counted || Math.max(1, Math.round(base64.length * 0.75 / 60_000));
}

const fileTokens = (file: LlmFile) =>
  file.type === "application/pdf" ? pagesOf(file.data) * PAGE : IMAGE;

/** What these messages, as a model is sent them, cost. */
export const weigh = (sent: LlmMessage[]) =>
  sent.reduce((sum, m) => {
    let tokens = tokensOf(m.text ?? "");
    if (m.role === "user") tokens += (m.files ?? []).reduce((n, f) => n + fileTokens(f), 0);
    if (m.role === "assistant") {
      for (const call of m.toolCalls ?? []) {
        tokens += tokensOf(call.name + JSON.stringify(call.input));
      }
      tokens += m.state?.tokens ?? 0;
    }
    return sum + tokens;
  }, 0);

/**
 * A message's weight: through its View, as agents see it (a step, as its
 * own agent: only it is ever sent its steps), or, failing that, its text.
 */
export async function weightOf(ctx: Context, m: Message): Promise<number> {
  const options = m.private ? { viewer: { kind: "agent", name: m.from } } : {};
  const sent = await ctx.render("llm", "message", m, options).catch(() => undefined);
  return Array.isArray(sent) ? weigh(sent as LlmMessage[]) : tokensOf(m.text ?? "");
}
