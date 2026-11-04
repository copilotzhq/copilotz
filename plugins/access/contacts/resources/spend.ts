/**
 * What a web line's visitors cost, for its `budget`: the contacts' listener
 * on the models plugin's `modelUse`, told every model call's use in the job
 * that made it. A call made for a web line's visitor (the turn working for
 * it, a transcription of what it sent) on a line with a budget is priced as
 * the usage ledger prices it (`usage.quote`), and counted against the line's
 * day (`contact.spent`). Nothing else is looked at.
 */
import { principalOf } from "../../../../runtime/mod.ts";
import type { ModelUse, UseContext, UseListener } from "../../../models/contract.ts";
import { lineOf } from "../shared/web.ts";

async function used(ctx: UseContext, use: ModelUse): Promise<void> {
  const visitor = principalOf(ctx.actor);
  if (visitor?.kind !== "contact" || typeof visitor.web !== "string" || !ctx.call) return;
  const line = lineOf(ctx, visitor.web);
  if (!line?.budget) return;
  const { price } = await ctx.call<{ price: number | null }>("usage.quote", {
    meter: use.meter,
    subject: use.subject,
    ...(use.catalog ? { catalog: use.catalog } : {}),
    quantities: Object.fromEntries(
      Object.entries(use.quantities).filter(([, n]) => typeof n === "number"),
    ),
  });
  if (price && price > 0) await ctx.call("contact.spent", { line: line.name, price });
}

export const visitorsSpend: UseListener = { used };
