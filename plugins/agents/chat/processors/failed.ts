/** A turn that failed for good, or was stopped, still answers, so whoever waits on it resumes. */
import type { Context, Event, ProcessorDef } from "../../../../runtime/mod.ts";
import type { Live } from "../collections/live.ts";
import type { Message } from "../collections/message.ts";
import { turnOf } from "../shared/agents.ts";
import { answer } from "../shared/delivery.ts";

export const failedProcessor: ProcessorDef = {
  on: "processor.failed",
  where: { processor: "chat.turn" },
  run: (ctx, event) => failed(ctx, event),
};

/**
 * Writes an answer for a turn that failed for good, so whoever waits on it
 * resumes. A stopped turn (`chat.stop`) answers with what it had written.
 */
const failed = async (ctx: Context, event: Event) => {
  const { event: run, type, data, error } = event.data as {
    event: string;
    type: string;
    data: Record<string, unknown>;
    error: { message?: string; code?: string };
  };
  const t = turnOf({ type, data });
  const messages = ctx.db.collection<Message>("message");
  if (await messages.findOne({ _id: `${run}:reply` })) return;
  if (error.code === "cancelled") {
    const written = await ctx.db.collection<Live>("live").findOne({ _id: run });
    const text = written?.text ? `${written.text} (stopped)` : "(stopped)";
    return await answer(ctx, t, run, text, { stopped: true });
  }
  // The org's limit isn't the agent failing: it says what happened, and who can change it.
  if (error.code === "credits" || error.code === "budget") {
    return await answer(ctx, t, run, error.message ?? "This org can't spend right now.", {
      failed: true,
    });
  }
  await answer(ctx, t, run, `${t.agent} failed: ${error.message ?? "unknown error"}`, {
    failed: true,
  });
};
