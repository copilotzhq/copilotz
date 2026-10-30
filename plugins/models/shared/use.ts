/**
 * Model use: after every call, the models plugin tells whoever plugs into
 * its `modelUse` resource what was used (the usage ledger records it, rated).
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

/** A `modelUse` resource: hears every model call's use. */
export type UseListener = { used(ctx: UseContext, use: ModelUse): void | Promise<void> };

/** Tells every `modelUse` listener about a use. Nobody listening: nothing happens. */
export function used(ctx: UseContext, use: ModelUse): void {
  for (
    const listener of Object.values((ctx.resources.modelUse ?? {}) as Record<string, UseListener>)
  ) {
    listener.used(ctx, use);
  }
}
