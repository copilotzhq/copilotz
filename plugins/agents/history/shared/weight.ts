/**
 * What a message costs the prompts it's in, in estimated tokens: what an
 * agent is actually sent for it, not just its text. Its files by what they
 * are (a text file's content as far as chat sends it, a transcript, an image
 * at what a large one costs, a PDF by its pages), and the rest through its
 * `message` View (the text, tool calls and results as their Views show them,
 * what it was told, its model's state as its adapter says). An estimate:
 * about four bytes of text a token.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { LlmFile, LlmMessage } from "../../../models/contract.ts";
import { type File, FILE_CHARS, type Message, textual } from "../../chat/contract.ts";
import { lineOf, size } from "./lines.ts";

/** An image, at the most providers charge for one (about 1.15 megapixels). */
export const IMAGE = 1_600;
/** A PDF's page: its text and its picture. */
export const PAGE = 2_000;
/** A PDF whose pages can't be counted (its objects compressed): guessed from its size, at most this. */
const GUESSED = 20;

/** Text's tokens, about four bytes each. */
export const tokensOf = (text: string) => Math.ceil(size(text) / 4);

/** A PDF's pages, as counted in it; else guessed from its size (up to GUESSED). */
export function pagesOf(base64: string): number {
  let raw = "";
  try {
    raw = atob(base64);
  } catch { /* not base64: guessed below */ }
  const counted = raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return counted || Math.min(GUESSED, Math.max(1, Math.round(base64.length * 0.75 / 60_000)));
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

type Attached = NonNullable<Message["files"]>[number];

/** A file as chat sends it, by what it is: only a PDF's content is read, for its pages. */
async function attachedTokens(ctx: Context, f: Attached): Promise<number> {
  if (f.transcript !== undefined) return tokensOf(f.transcript) + 12;
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return IMAGE;
  if (f.type === "application/pdf") {
    const data = (await ctx.db.collection<File>("file").findOne({ _id: f.id }))?.data;
    return (data ? pagesOf(data) : GUESSED) * PAGE;
  }
  if (textual(f.type)) return Math.ceil(Math.min(f.size, FILE_CHARS) / 4) + 12;
  return 16; // Named only.
}

/**
 * A message's weight. Rendered as its sender sees it when it's its own (a
 * step, or an answer with what it was told or its state: only it is sent
 * those), else as any agent does; its files apart, by what they are.
 */
export async function weightOf(ctx: Context, m: Message): Promise<number> {
  const files = (await Promise.all((m.files ?? []).map((f) => attachedTokens(ctx, f))))
    .reduce((a, b) => a + b, 0);
  const own = m.private || m.told || m.state;
  const bare = m.files?.length ? { ...m, files: undefined } : m;
  const options = own ? { viewer: { kind: "agent", name: m.from } } : {};
  const sent = await ctx.render("llm.message", bare, options).catch(() => undefined);
  return files + (Array.isArray(sent) ? weigh(sent as LlmMessage[]) : tokensOf(lineOf(m)));
}
