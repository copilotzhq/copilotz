/**
 * A booking app for tests of turns cut short. Its agent, `clerk`, books a
 * seat with the `book` tool: each run of the tool is recorded (`run`, a
 * write of its own, like an outside call), it charges through a recorded
 * Action (`booking.charge`), and it answers `booked <seat>`. Its model picks
 * a new seat each time it's asked (unless `seat` says otherwise), so a step
 * asked for twice shows, and answers `done: <what the tool said>`.
 */
import { defineAction, defineCollection, definePlugin } from "../../../../runtime/mod.ts";
import type { LlmAdapter } from "../../../models/mod.ts";
import { type Step, tool } from "../../chat/mod.ts";

export type Booking = {
  /** Each run of the tool waits on this before it answers (a call cut short, if it never does). */
  hold?: (run: { callId: string; retry: boolean }) => Promise<unknown> | void;
  /** True while the tool's `llm` View should fail: a step failing after its tools ran. */
  failView?: () => boolean;
  /** How long the model takes before it answers (ms). */
  delayMs?: number;
  /** The seat it picks the nth time it's asked (by default, n). */
  seat?: (n: number) => number;
};

export type Run = { _id: string; callId: string; retry: boolean; seat: number };

export function booking(options: Booking = {}) {
  let asked = 0;
  const model: LlmAdapter = {
    async *generate({ messages }) {
      const n = ++asked;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const last = messages.at(-1)!;
      if (last.role === "tool") return yield { type: "text", text: `done: ${last.text}` };
      yield { type: "text", text: "Booking it." };
      const seat = options.seat?.(n) ?? n;
      yield { type: "tool_call", call: { id: `c${n}`, name: "book", input: { seat } } };
    },
  };
  const plugin = definePlugin({
    name: "booking",
    collections: {
      run: defineCollection({ schema: { type: "object" }, events: false }),
      charge: defineCollection({ schema: { type: "object" }, events: false }),
    },
    actions: {
      "booking.charge": defineAction({
        input: { type: "object", properties: { seat: { type: "number" } }, required: ["seat"] },
        run: async (ctx, { seat }) => {
          await ctx.db.collection("charge").insertOne({ seat });
          return { charged: seat };
        },
      }),
    },
    resources: {
      provider: { booking: { adapter: "booking" } },
      agents: {
        clerk: { instructions: "You book seats.", model: "booking/clerk", tools: ["book"] },
      },
      tools: {
        book: tool({
          description: "Books a seat, and charges for it.",
          input: { type: "object", properties: { seat: { type: "number" } }, required: ["seat"] },
          run: async ({ seat }, ctx) => {
            await ctx.db.collection("run").insertOne({
              callId: ctx.callId,
              retry: ctx.retry,
              seat,
            });
            await ctx.call("booking.charge", { seat });
            await options.hold?.({ callId: ctx.callId, retry: ctx.retry });
            return `booked ${seat}`;
          },
        }),
      },
    },
    views: {
      "tool:book": (step: Step) => {
        if (options.failView?.()) throw new Error("the view failed after the tool ran");
        return step.output;
      },
    },
    adapters: { llm: { booking: model } },
  });
  return { plugin, asked: () => asked };
}
