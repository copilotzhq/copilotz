import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmMessage } from "../../../models/contract.ts";
import type { Message } from "../../chat/contract.ts";
import type { Outline } from "../collections/outline.ts";
import type { Summary } from "../collections/summary.ts";
import { node, type Outlined } from "../shared/lines.ts";
import { summaryView } from "./summary.ts";
import { idsIn, namesIn, withNames } from "../../../access/spaces/contract.ts";

const HEADER = "Earlier in this conversation, summarized, oldest first. Each line is id+n|text: " +
  "the n messages from id on. zoom(id, n) opens a line into the two it was made from; " +
  "zoom(id, 1) gives a message whole. Tool results aren't kept in summaries: say in your " +
  "replies what you learned that will matter later.";

/**
 * The conversation an agent is sent: the outline's lines, then the messages
 * still whole, each through its View. Without an outline, every message.
 */
export function historyView(
  { thread, messages }: { thread: Outlined; messages: Message[] },
  ctx: ViewContext,
): LlmMessage[] {
  const whole = (list: Message[]) =>
    list.flatMap((m) => (ctx.show("message", m) ?? []) as LlmMessage[]);
  if (!thread.outlined) return whole(messages);
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
  if (state.status !== "ready" || !state.value?.boundary) return whole(messages);
  const ids = (state.value.lines as number[][]).map(([level, index]) =>
    node(thread._id, level, index)
  );
  const found = ctx.db.collection<Summary>("summary").find({ _id: { $in: ids } });
  if (found.status !== "ready") return [];
  const byId = new Map(found.value.map((s) => [s._id, s]));
  const lines = ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [String(ctx.show("summary", s) ?? summaryView(s))] : [];
  });
  const since = state.value.since ?? "";
  // Lines kept before names were known say people's ids: each by name now.
  const outline = lines.join("\n");
  const named = withNames(outline, namesIn(ctx, idsIn(outline)));
  return [
    { role: "user", text: `${HEADER}\n<chat>\n${named}\n</chat>` },
    ...whole(messages.filter((m) => m.at >= since)),
  ];
}
