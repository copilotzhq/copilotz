/** A use, as the ledger takes it, and recording one: rated, appended, counted. */
import type { Actor, Context, ReadContext } from "../../../../runtime/mod.ts";
import { personOf } from "../../../../runtime/mod.ts";
import { nonzero, rate } from "./rate.ts";

/** One use of something: a model call, an API call, a machine's seconds. */
export type Use = {
  /** What measures it: `llm`, `embeddings`, `transcription`, `tool`, `compute`… */
  meter: string;
  /** What was used: a model (`"provider/model"`), a tool, a machine size. */
  subject: string;
  /** The catalog entry that prices it when nothing else does (a model's). */
  catalog?: string;
  /** What it's measured in: tokens (`input`, `output`, …), `seconds`, `calls`, or units of your own. */
  quantities: Record<string, number | undefined>;
  /** Who and what it was for (thread, agent, tenant…). */
  tags?: Record<string, string>;
  /** When it was used (now, by default). */
  at?: string;
};

/** What recording reaches: the resources, where a job records (missing in plain calls), who acted. */
export type UseContext = Pick<Context, "resources"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
};

/**
 * The person a use was for: who acted, or whom an agent (`for`) or trusted
 * code (`via`) acted for. None: the system's own.
 */
/**
 * A record's price: as rated, or, for a use recorded before every use had a
 * price (nothing rated it), its cost: a margin of 0.
 */
export function priceOf(
  record: { price?: number; cost?: number; rated?: { price?: unknown }; kind?: string },
): number | undefined {
  if (record.price !== undefined) return record.price;
  return record.kind !== "adjustment" && !record.rated?.price ? record.cost : undefined;
}

/** Rates a use and appends it to the ledger; its cost and price are counted as metrics too. */
export async function recordUse(ctx: UseContext, use: Use): Promise<void> {
  // Where nothing can record (a plain call outside a job), there's no ledger to write.
  if (!ctx.record) return;
  const at = use.at ?? new Date().toISOString();
  const quantities = nonzero(use.quantities);
  const rated = await rate(ctx, { ...use, quantities, at });
  // Whose it was, so each person sees their own.
  const person = personOf(ctx.actor);
  const tags = { ...use.tags, ...(person ? { person } : {}) };
  ctx.record("usage", {
    meter: use.meter,
    subject: use.subject,
    ...(use.catalog ? { catalog: use.catalog } : {}),
    quantities,
    ...(Object.keys(tags).length ? { tags } : {}),
    ...rated,
    at,
  });
  // What it cost and what it's charged, as metrics too (for dashboards, not invoices).
  const attributes = { meter: use.meter, subject: use.subject };
  if (rated.cost) {
    ctx.metrics?.counter("copilotz.usage.cost", { unit: "USD", description: "Cost of uses" })
      .add(rated.cost, attributes);
  }
  if (rated.price) {
    ctx.metrics?.counter("copilotz.usage.price", { unit: "USD", description: "Price of uses" })
      .add(rated.price, attributes);
  }
}
