/** `zoom`: opens a summary line into the two it was made from, down to the message whole. */
import type { Context } from "../../../../runtime/mod.ts";
import { type Message, tool } from "../../chat/contract.ts";
import type { Summary } from "../collections/summary.ts";
import { lineOf, node, type Outlined } from "../shared/lines.ts";
import { namesFor } from "../../../access/spaces/contract.ts";
import { summarized } from "../shared/summarized.ts";
import { summaryView } from "../views/summary.ts";

export const zoom = tool({
  // Only where there is a summary to open.
  offer: (_agent, thread, ctx) =>
    Boolean((thread as Outlined).outlined && summarized(thread._id, ctx)),
  description:
    "Open a line of the summarized conversation: zoom(id, n) with the line's id+n gives the two " +
    "lines it was made from (n/2 messages each); zoom(id, 1) gives the message whole. Whenever you " +
    "need something from earlier, find its latest mention in the summary and zoom until you have " +
    "it whole, before you act, guess or ask.",
  input: {
    type: "object",
    properties: {
      id: { type: "integer", description: "The line's first message, as in id+n." },
      n: { type: "integer", description: "How many messages the line covers, as in id+n." },
    },
    required: ["id", "n"],
  },
  run: (input, ctx) => open(ctx, ctx.thread, input),
});

/** Runs `zoom` for a thread. */
async function open(
  ctx: Context,
  thread: string,
  input: Record<string, unknown>,
): Promise<string> {
  const [id, n] = [Number(input.id), Number(input.n)];
  if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || n & (n - 1) || id % n) {
    return "Error: zoom takes a line's id and n, as written: id+n.";
  }
  const nodes = ctx.db.collection<Summary>("summary");
  if (n === 1) {
    const line = await nodes.findOne({ _id: node(thread, 0, id) });
    const message = line?.message
      ? await ctx.db.collection<Message>("message").findOne({ _id: line.message })
      : null;
    return message
      ? `${id}+1|${lineOf(message, await namesFor(ctx, [message.from, ...message.to]))}`
      : `Error: no message ${id} here.`;
  }
  const level = Math.log2(n) - 1;
  const half = n / 2;
  const children = await Promise.all([
    nodes.findOne({ _id: node(thread, level, id / half) }),
    nodes.findOne({ _id: node(thread, level, id / half + 1) }),
  ]);
  if (!children[0] || !children[1]) return `Error: no line ${id}+${n} here.`;
  return children.map((s) => summaryView(s!)).join("\n");
}
