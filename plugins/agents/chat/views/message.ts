import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmFile, LlmMessage, LlmState } from "../../../models/contract.ts";
import { type File, FILE_CHARS, text, textual } from "../collections/file.ts";
import { isAnswer, type Message } from "../collections/message.ts";
import type { AdditionShown } from "../collections/shown.ts";
import { DELEGATED, type Step, type Told } from "../shared/types.ts";
import { nameOf, namesIn } from "../../../access/spaces/contract.ts";

/** Files a model may be shown as they are: images and PDFs (the models plugin decides, by model). */
const viewable = (type: string) =>
  /^image\/(png|jpeg|gif|webp)$/.test(type) || type === "application/pdf";

/**
 * Its files, as an agent reads them: text files' content, what audio says,
 * images and PDFs as they are (named in the text too), the rest by name.
 * Each file's content is read on its own, all in the same pass: one answer
 * from the owner carries one file, never a message's files together, which
 * could pass the most one answer carries (16 MiB).
 */
function attached(m: Message, ctx: ViewContext): { text: string; files: LlmFile[] } {
  if (!m.files?.length) return { text: "", files: [] };
  const files: LlmFile[] = [];
  const lines = m.files.map((f) => {
    const data = textual(f.type) || viewable(f.type)
      ? ctx.db.collection<File>("file").findOne({ _id: f.id }).value?.data
      : undefined;
    if (f.transcript !== undefined) {
      return `\n[${f.voice ? "voice message" : `audio ${f.name}`}, transcribed]\n${f.transcript}` +
        `\n[end of ${f.voice ? "voice message" : f.name}]`;
    }
    if (data !== undefined && viewable(f.type)) {
      files.push({ name: f.name, type: f.type, data });
      return `\n[${f.type === "application/pdf" ? "pdf" : "image"} ${f.name}]`;
    }
    if (data === undefined || !textual(f.type)) {
      return `\n[file ${f.name}: ${f.type}, ${f.size} bytes]`;
    }
    const content = text(data);
    const cut = content.length > FILE_CHARS ? `${content.slice(0, FILE_CHARS)}\n[…cut]` : content;
    return `\n[file ${f.name}]\n${cut}\n[end of ${f.name}]`;
  });
  return { text: lines.join(""), files };
}

/**
 * What went out after an answer beyond its text (an addition: a carousel of
 * trips), as the model is told: `[then shown: <note>]`. One read per pass,
 * for the whole chat.
 */
function shownAfter(m: Message, ctx: ViewContext): string {
  if (!isAnswer(m)) return "";
  const shown = ctx.db.collection<AdditionShown>("shown").find({ thread: m.thread }).value ?? [];
  return shown.filter((s) => s.after === m._id && s.note)
    .map((s) => `\n[then shown: ${s.note}${s.fallback ? " (as text)" : ""}]`).join("");
}

/**
 * A message as the viewing agent sees it: its own as its turns (after what it
 * was told then), others' as labelled input. So is what it handed between
 * spaces itself: that was other work, in another chat, not this turn's. A
 * choice tapped says what it was (`[tapped: trip:123]`); an answer, what went
 * out after it.
 */

export function messageView(m: Message, ctx: ViewContext): LlmMessage[] {
  const me = ctx.viewer?.name;
  const handed = m.via?.kind === DELEGATED;
  const then = shownAfter(m, ctx);
  if (m.from !== me || handed) {
    // People by name (an agent's own name is as it is).
    const names = namesIn(ctx, [m.from, ...m.to]);
    const to = !me || m.to.includes(me) || !m.to.length
      ? ""
      : ` → ${m.to.map((who) => nameOf(who, names)).join(", ")}`;
    const { text: notes, files } = attached(m, ctx);
    // Sent for them, not typed now: they may not be there to answer.
    const via = m.via ? ` (via ${m.via.kind} "${m.via.name}")` : "";
    const tapped = m.tap ? ` [tapped: ${m.tap.id}]` : "";
    return [{
      role: "user",
      text: `${m.from === me ? "You" : nameOf(m.from, names)}${via}${to}: ${
        m.text ?? ""
      }${tapped}${notes}${then}`,
      ...(files.length ? { files } : {}),
    }];
  }
  // What it was told at the start of the turn, where it was told it.
  const told: LlmMessage[] = m.told?.length
    ? [{ role: "user", text: (m.told as Told[]).map((c) => c.text).join("\n\n") }]
    : [];
  // Its model's state goes back with it: thinking, signatures (only to the model that wrote them).
  const state = m.state ? { state: m.state as LlmState } : {};
  if (!m.toolCalls?.length) {
    return [...told, { role: "assistant", text: `${m.text ?? ""}${then}`, ...state }];
  }
  const calls = m.toolCalls as Step[];
  return [
    ...told,
    {
      role: "assistant",
      text: m.text || undefined,
      toolCalls: calls.map(({ id, name, input }) => ({ id, name, input })),
      ...state,
    },
    ...calls.map((c): LlmMessage => {
      // A tool's own View decides how its result reads (clipped, summarized…).
      const shown = ctx.show(`tool:${c.name}`, c);
      return { role: "tool", toolCallId: c.id, text: typeof shown === "string" ? shown : c.output };
    }),
  ];
}
