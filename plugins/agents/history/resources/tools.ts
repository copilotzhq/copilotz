/**
 * `zoom`: opens a summary line into the two it was made from, down to the
 * message whole; a line of the agent's own steps (`s…`), down to the step.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { LlmMessage } from "../../../models/contract.ts";
import { type Message, tool } from "../../chat/contract.ts";
import type { Summary } from "../collections/summary.ts";
import { lineOf, node, type Outlined, stepOf } from "../shared/lines.ts";
import { namesFor } from "../../../access/spaces/contract.ts";
import { summarized } from "../shared/summarized.ts";
import { summaryView } from "../views/summary.ts";

export const zoom = tool({
  // Only where there is a summary to open.
  offer: (_agent, thread, ctx) =>
    Boolean((thread as Outlined).outlined && summarized(thread._id, ctx)),
  description:
    "Open a line of the summarized conversation: zoom(id, n) with the line's id+n gives the two " +
    "lines it was made from (n/2 messages each); zoom(id, 1) gives the message whole. Lines of " +
    "your own steps open the same way, their id as written (s12). Whenever you need something " +
    "from earlier, find its latest mention in the summary and zoom until you have it whole, " +
    "before you act, guess or ask.",
  input: {
    type: "object",
    properties: {
      id: {
        anyOf: [{ type: "integer" }, { type: "string", pattern: "^s?\\d+$" }],
        description: "The line's first message, as in id+n: 12, or s12 for your own steps.",
      },
      n: { type: "integer", description: "How many messages the line covers, as in id+n." },
    },
    required: ["id", "n"],
  },
  run: (input, ctx) => open(ctx, ctx.thread, input, ctx.agent),
});

/** Runs `zoom` for a thread: in its tree, or (`s…`) in the calling agent's tree of its steps. */
async function open(
  ctx: Context,
  thread: string,
  input: Record<string, unknown>,
  agent?: string,
): Promise<string> {
  const written = String(input.id);
  const steps = written.startsWith("s");
  const [id, n] = [Number(steps ? written.slice(1) : written), Number(input.n)];
  if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || n & (n - 1) || id % n) {
    return "Error: zoom takes a line's id and n, as written: id+n.";
  }
  const s = steps ? "s" : "";
  if (steps && !agent) return `Error: no line ${s}${id}+${n} here.`;
  const mine = steps ? agent : undefined;
  const nodes = ctx.db.collection<Summary>("summary");
  if (n === 1) {
    const line = await nodes.findOne({ _id: node(thread, 0, id, mine) });
    const message = line?.message && line.agent === mine
      ? await ctx.db.collection<Message>("message").findOne({ _id: line.message })
      : null;
    if (!message || (steps && message.from !== agent)) return `Error: no message ${s}${id} here.`;
    // As the agent is sent it: text files' content and transcripts too (images and PDFs by name).
    const viewer = agent ? { viewer: { kind: "agent", name: agent } } : {};
    const shown = await ctx.render("llm.message", message, viewer).catch(() => undefined);
    const text = !Array.isArray(shown)
      ? lineOf(message, await namesFor(ctx, [message.from, ...message.to]))
      : steps
      ? stepOf(agent!, shown as LlmMessage[])
      : (shown as LlmMessage[]).map((m) => m.text ?? "").join("\n");
    return `${s}${id}+1|${text}`;
  }
  const level = Math.log2(n) - 1;
  const half = n / 2;
  const children = await Promise.all([
    nodes.findOne({ _id: node(thread, level, id / half, mine) }),
    nodes.findOne({ _id: node(thread, level, id / half + 1, mine) }),
  ]);
  if (!children[0] || !children[1]) return `Error: no line ${s}${id}+${n} here.`;
  return children.map((c) => summaryView(c!)).join("\n");
}
