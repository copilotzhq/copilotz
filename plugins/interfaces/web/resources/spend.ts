/**
 * What a web line's visitors cost, for its `budget`: the web lines' listener
 * on the models plugin's `modelUse`, told every model call's use in the job
 * that made it, and asked before each (`may`). A call made for a web line's
 * visitor (the turn working for it, a transcription of what it sent) on a
 * line with a budget:
 *
 * - before it's made, is refused once the line's day is spent (or closed):
 *   a turn's tool loop stops there (`contact.budget`);
 * - once made, is priced as the usage ledger prices it (`usage.quote`) and
 *   charged to the line's day, the visitor's hold with it (`contact.spent`).
 *   Use nothing prices (the ledger has no price for its model, or pricing
 *   failed) closes the line for the day, said in the log as it does: a
 *   budget that can't be counted holds nothing.
 *
 * Nothing else is looked at.
 */
import { failure, principalOf } from "../../../../runtime/mod.ts";
import type { ModelUse, UseContext, UseListener } from "../../../models/contract.ts";
import { BUDGET } from "../shared/budget.ts";
import { lineOf } from "../shared/lines.ts";

/** The budgeted line a call is made for, and its visitor: none for anyone else. */
function budgeted(ctx: UseContext) {
  const visitor = principalOf(ctx.actor);
  if (visitor?.kind !== "contact" || typeof visitor.web !== "string" || !ctx.call) return;
  const line = lineOf(ctx, visitor.web);
  return line?.budget ? { line: line.name, contact: visitor.id, call: ctx.call } : undefined;
}

async function used(ctx: UseContext, use: ModelUse): Promise<void> {
  const on = budgeted(ctx);
  if (!on) return;
  const price = await on.call<{ price: number | null }>("usage.quote", {
    meter: use.meter,
    subject: use.subject,
    ...(use.catalog ? { catalog: use.catalog } : {}),
    quantities: Object.fromEntries(
      Object.entries(use.quantities).filter(([, n]) => typeof n === "number"),
    ),
  }).then(({ price }) => price, () => null);
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
    await on.call("contact.spent", { line: on.line, contact: on.contact, price });
    return;
  }
  const { closed } = await on.call<{ closed?: boolean }>("contact.spent", {
    line: on.line,
    contact: on.contact,
    unpriced: use.subject,
  });
  if (closed) {
    console.error(
      `web.lines.${on.line}: what its visitors used (${use.subject}) has no price, so its ` +
        "budget can't be kept: the line takes no more messages today. Price the model " +
        "(the usage plugin's price resource, or its catalog).",
    );
  }
}

async function may(ctx: UseContext): Promise<void> {
  const on = budgeted(ctx);
  if (!on) return;
  const { left } = await on.call<{ left: boolean }>("contact.budget", { line: on.line });
  if (!left) throw failure("too_many", BUDGET.spent, { public: true });
}

export const visitorsSpend: UseListener = { used, may };
