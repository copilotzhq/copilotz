/**
 * Model use: after every call, the models plugin tells whoever plugs into
 * its `modelUse` resource what was used (the usage ledger records it, rated);
 * before one, a listener may refuse it (`may`: a budget spent).
 * It's called in the job that made the call, so what a listener records
 * (`ctx.record`) rides that job's next write and is kept even if the job
 * fails. Models' own metrics (tokens, time) are its telemetry.
 */
import type { Actor, Context, ReadContext } from "../../../runtime/mod.ts";

/** One model call's use. */
export type ModelUse = {
  /** Which port: `llm`, `embeddings`, `transcription`. */
  meter: string;
  /** The model that answered (`"provider/model"`). */
  subject: string;
  /** Its catalog entry, which prices it when nothing else does. */
  catalog?: string;
  /** Tokens (`input`, `output`, `cached`, `cacheWrite`, `reasoning`), seconds… */
  quantities: Record<string, number | undefined>;
  /** Who and what it was for (thread, agent, purpose…). */
  tags?: Record<string, string>;
  /** When (now, by default). */
  at?: string;
};

/**
 * What a listener reaches: the resources, Actions to ask, where a job records
 * (missing in plain calls), and who the call was made as.
 */
export type UseContext = Pick<Context, "resources"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
};

/** A model call about to be made: which port, which model, and whom it's for. */
export type ModelCall = Pick<ModelUse, "meter" | "subject" | "tags">;

/**
 * A `modelUse` resource: hears every model call's use; and may say, before
 * one, whether it may go (`may`: one that throws refuses it, and its turn
 * stops there: a budget spent).
 */
export type UseListener = {
  used(ctx: UseContext, use: ModelUse): void | Promise<void>;
  may?(ctx: UseContext, call: ModelCall): void | Promise<void>;
};

/**
 * Asks every `modelUse` listener that says whether a call may go (`may`):
 * one that refuses (throws) refuses it, for good (`final`: trying again, or
 * another model, won't help).
 */
export async function mayUse(ctx: UseContext, call: ModelCall): Promise<void> {
  const listeners = Object.values((ctx.resources.modelUse ?? {}) as Record<string, UseListener>);
  for (const listener of listeners) {
    if (!listener.may) continue;
    try {
      await listener.may(ctx, call);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        final: true,
      });
    }
  }
}

/**
 * Tells every `modelUse` listener about a use, and waits for them: what one
 * records has to go with the job that made the call, and a job's last write
 * can be close behind. One that fails is logged; the call goes on.
 */
export async function used(ctx: UseContext, use: ModelUse): Promise<void> {
  const listeners = Object.values((ctx.resources.modelUse ?? {}) as Record<string, UseListener>);
  await Promise.all(listeners.map(async (listener) => {
    try {
      await listener.used(ctx, use);
    } catch (error) {
      console.error(
        `models: a listener failed on ${use.subject}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }));
}
