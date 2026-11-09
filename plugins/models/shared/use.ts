/**
 * Model use: after every call, the models plugin tells whoever plugs into
 * its `modelUse` resource what was used (the usage ledger records it, rated);
 * before one, a listener may refuse it (`may`: a budget spent), and so may
 * the org's limits (the `spending` resource), unless its own key pays.
 * It's called in the job that made the call, so what a listener records
 * (`ctx.record`) rides that job's next write and is kept even if the job
 * fails. Models' own metrics (tokens, time) are its telemetry.
 */
import type { Actor, Context, ReadContext } from "../../../runtime/mod.ts";
import { failure } from "../../../runtime/mod.ts";
import { keyable, type ModelKeys, type Resolved } from "./choice.ts";

/** One model call's use. */
export type ModelUse = {
  /** Which port: `llm`, `embeddings`, `transcription`, `image`. */
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
 * (missing in plain calls), who the call was made as, and, in a job, the
 * system to act as (`as`: a grant), for bookkeeping that isn't the actor's to
 * ask for (none in a read).
 */
export type UseContext = Pick<Context, "resources"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
  as?: Context["as"];
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

/**
 * A model with its org's own key for its provider, which goes before the
 * app's. A provider only an org's key reaches, without one, is told so.
 */
export async function keyed(ctx: UseContext, m: Resolved): Promise<Resolved> {
  const keys = ctx.resources.modelKeys as ModelKeys | undefined;
  if (!keys || !keyable(m.provider)) return m;
  // From a read there's no system to ask as, and so no key: only the app's.
  const key = ctx.as
    ? await ctx.as().call<string | null>(keys.open, { provider: m.provider })
    : null;
  if (key) {
    return {
      ...m,
      endpoint: { ...m.endpoint, apiKey: key },
      tags: { ...m.tags, paid: "own-key" },
    };
  }
  if (m.endpoint.apiKey || m.endpoint.headers) return m;
  throw failure("key_missing", `There's no key for ${m.provider}: this org's admins can add one.`);
}

/**
 * Whether what's about to run may spend (the `spending` resource: whoever
 * keeps an org's limits), which isn't asked for a model the app doesn't pay for
 * (the org's own key, a person's subscription). Saying no is final:
 * trying again won't help.
 */
export async function mayRun(
  ctx: UseContext,
  m: Resolved,
  meter: string,
  tags?: Record<string, string>,
): Promise<void> {
  // Whoever listens to model use may refuse it first (a web line's budget, spent): a model
  // the app doesn't pay for too, since the line's budget counts a visitor's use of any.
  await mayUse(ctx, { meter, subject: m.id, ...(tags ? { tags } : {}) });
  if (m.tags?.paid) return;
  const spending = ctx.resources.spending as { check?: string } | undefined;
  if (!spending?.check || !ctx.as) return;
  const purpose = tags?.purpose;
  const verdict = await ctx.as().call<{ ok: boolean; why?: string; message?: string }>(
    spending.check,
    purpose ? { purpose } : {},
  );
  if (verdict.ok) return;
  throw Object.assign(
    failure(verdict.why ?? "spending", verdict.message ?? "This org can't spend right now.", {
      // Its words are for whoever asked ("your subscription isn't active"): a failed turn
      // says them in its chat.
      public: true,
    }),
    { final: true },
  );
}
