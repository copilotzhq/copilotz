import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmFile, LlmMessage, LlmState } from "../../../models/contract.ts";
import { type File, text, textual } from "../collections/file.ts";
import type { Message } from "../collections/message.ts";
import type { Step } from "../shared/types.ts";
import { nameOf, namesIn } from "../../../access/spaces/contract.ts";

/** How much of a text file an agent is sent. */
const FILE_CHARS = 20_000;

/** Files a model may be shown as they are: images and PDFs (the models plugin decides, by model). */
const viewable = (type: string) =>
  /^image\/(png|jpeg|gif|webp)$/.test(type) || type === "application/pdf";

/**
 * Its files, as an agent reads them: text files' content, what audio says,
 * images and PDFs as they are (named in the text too), the rest by name.
 */
function attached(m: Message, ctx: ViewContext): { text: string; files: LlmFile[] } {
  if (!m.files?.length) return { text: "", files: [] };
  const wanted = m.files.filter((f) => textual(f.type) || viewable(f.type)).map((f) => f.id);
  const loaded = wanted.length
    ? ctx.db.collection<File>("file").find({ _id: { $in: wanted } }).value ?? []
    : [];
  const files: LlmFile[] = [];
  const lines = m.files.map((f) => {
    const data = loaded.find((c) => c._id === f.id)?.data;
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

/** A message as the viewing agent sees it: its own as its turns, others' as labelled input. */

export function messageView(m: Message, ctx: ViewContext): LlmMessage[] {
  const me = ctx.viewer?.name;
  if (m.from !== me) {
    // People by name (an agent's own name is as it is).
    const names = namesIn(ctx, [m.from, ...m.to]);
    const to = !me || m.to.includes(me) || !m.to.length
      ? ""
      : ` → ${m.to.map((who) => nameOf(who, names)).join(", ")}`;
    const { text: notes, files } = attached(m, ctx);
    return [{
      role: "user",
      text: `${nameOf(m.from, names)}${to}: ${m.text ?? ""}${notes}`,
      ...(files.length ? { files } : {}),
    }];
  }
  if (!m.toolCalls?.length) return [{ role: "assistant", text: m.text ?? "" }];
  const calls = m.toolCalls as Step[];
  return [
    {
      role: "assistant",
      text: m.text || undefined,
      toolCalls: calls.map(({ id, name, input }) => ({ id, name, input })),
      ...(m.state ? { state: m.state as LlmState } : {}),
    },
    ...calls.map((c): LlmMessage => {
      // A tool's own View decides how its result reads (clipped, summarized…).
      const shown = ctx.show(`tool:${c.name}`, c);
      return { role: "tool", toolCallId: c.id, text: typeof shown === "string" ? shown : c.output };
    }),
  ];
}
