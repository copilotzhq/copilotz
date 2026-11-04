/** A turn that failed for good, or was stopped, still answers, so whoever waits on it resumes. */
import type { Context, Event, ProcessorDef } from "../../../../runtime/mod.ts";
import type { Intent } from "../collections/intent.ts";
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
 * resumes. A stopped turn (`chat.stop`) answers with what it had written,
 * when that was surely an answer (its turn offered no tools).
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
    const [written, taking] = await Promise.all([
      ctx.db.collection<Live>("live").findOne({ _id: run }),
      ctx.db.collection<Intent>("intent").findOne({ _id: run }),
    ]);
    // Text of a step it was taking stays that step's (the answer keeps it); so do words not yet
    // known to be an answer (its turn offers tools: they may have been a step's), which everyone in
    // the chat, a contact too, would read.
    const text = written?.text && written.open && !taking
      ? `${written.text} (stopped)`
      : "(stopped)";
    return await answer(ctx, t, run, text, { stopped: true });
  }
  // The org's limit isn't the agent failing: it says what happened, and who can change it.
  if (error.code === "credits" || error.code === "budget") {
    return await answer(ctx, t, run, error.message ?? "This org can't spend right now.", {
      failed: true,
    });
  }
  await answer(ctx, t, run, `${t.agent} failed: ${toldOf(error)}`, { failed: true });
};

/** What anyone in the chat reads of a failure, a customer too. */
const FAILED = "something went wrong, so it couldn't answer. Try again in a moment.";

/**
 * What went wrong, as people are told it: a missing key says who can add one;
 * anything else (a provider's refusal and its body, a network error) is for
 * whoever runs the app, and stays in the `processor.failed` event.
 */
const toldOf = (error: { message?: string; code?: string }) =>
  error.code === "key_missing" && error.message ? error.message : FAILED;
