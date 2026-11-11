import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmMessage } from "../../../models/contract.ts";
import type { Message } from "../../chat/contract.ts";
import type { Line, Outline } from "../collections/outline.ts";
import type { Summary } from "../collections/summary.ts";
import { node, type Outlined } from "../shared/lines.ts";
import { hasLines } from "../shared/summarized.ts";
import { summaryView } from "./summary.ts";
import { idsIn, namesIn, withNames } from "../../../access/spaces/contract.ts";

const HEADER = "Earlier in this conversation, summarized, oldest first. Each line is id+n|text: " +
  "the n messages from id on; a line whose id starts with s is your own steps (your tool calls " +
  "and what they returned), which only you see. zoom(id, n) opens a line into the two it was " +
  "made from; zoom(id, 1) gives a message or a step whole.";

/**
 * The conversation an agent is sent: the outline's lines with its own steps'
 * among them, then the messages still whole, each through its View. Without
 * an outline, every message. With `from` (where the agent's window by age
 * starts), only lines whose newest message is that new.
 */
export function historyView(
  { thread, messages, from }: { thread: Outlined; messages: Message[]; from?: string },
  ctx: ViewContext,
): LlmMessage[] {
  const whole = (list: Message[]) =>
    list.flatMap((m) => (ctx.show("llm.message", m) ?? []) as LlmMessage[]);
  if (!thread.outlined) return whole(messages);
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
  if (state.status !== "ready" || !hasLines(state.value)) return whole(messages);
  const since = state.value.since ?? "";
  // A model's state from before the last cut is bound to how the conversation began then (a
  // provider may refuse it): it goes, and the model thinks afresh.
  const cutAt = state.value.cutAt ?? "";
  const fresh = (m: Message) => m.state && m.at <= cutAt ? { ...m, state: undefined } : m;
  const recent = messages.filter((m) => m.at >= since).map(fresh);
  // Lines all older than the agent's window by age go, as their messages did; so do lines
  // kept before they said when their newest message was written (`until`).
  const within = (lines: Line[]) =>
    from ? lines.filter(([, , , until]) => until !== undefined && until >= from) : lines;
  const name = ctx.viewer?.name;
  const mine = name ? state.value.steps?.[name] : undefined;
  // Its own steps' lines among the thread's, by when their newest message was written.
  const ids = interleave(
    within(state.value.lines as Line[]).map((line) => [line, node(thread._id, line[0], line[1])]),
    within(mine?.lines ?? []).map((line) => [line, node(thread._id, line[0], line[1], name)]),
  );
  if (!ids.length) return whole(recent);
  const found = ctx.db.collection<Summary>("summary").find({ _id: { $in: ids } });
  if (found.status !== "ready") return [];
  const byId = new Map(found.value.map((s) => [s._id, s]));
  const lines = ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [String(ctx.show("summary", s) ?? summaryView(s))] : [];
  });
  // Lines kept before names were known say people's ids: each by name now.
  const outline = lines.join("\n");
  const named = withNames(outline, namesIn(ctx, idsIn(outline)));
  return [{ role: "user", text: `${HEADER}\n<chat>\n${named}\n</chat>` }, ...whole(recent)];
}

/** Two runs of lines, each in order, as one in order of `until` (lines without one first). */
function interleave(a: [Line, string][], b: [Line, string][]): string[] {
  const out: string[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    const first = j >= b.length || (i < a.length && (a[i][0][3] ?? "") <= (b[j][0][3] ?? ""));
    out.push(first ? a[i++][1] : b[j++][1]);
  }
  return out;
}
