/**
 * Credits: what an org has to spend, and the check that stops it at its limit.
 * Built on the usage ledger, whose prices it counts.
 *
 * - **The org pays.** Its plan (`billingPlan`), credits (`credit`) and payments
 *   (`payment`) are its own rows. A plan's terms are data, so a contract is a
 *   record, not code. Nothing asks a payment provider what an org has.
 * - **Balance:** credits less what the ledger charged since its plan began,
 *   walked day by day (shared/walk.ts), so usage from before never counts, and
 *   credits lapse on their day. Own keys and subscriptions are charged nothing.
 * - **The check** (`billing.check`, named by the `spending` resource, which
 *   whatever spends reads): `room` is the smaller of balance and budget left,
 *   in the owner's memory, so asking costs no database read, and each use takes
 *   its price off. Memory can only say yes: before anyone's stopped, it's worked
 *   out again from what's kept.
 * - **By hand now, by provider later:** staff change plans, give credits, waive
 *   and record payments (actions/manage.ts); a provider's webhook calls
 *   `billing.apply` with its own event id, which lands in the same place.
 * - **`enforce`** off: nothing starts and nobody's stopped; staff can prepare.
 *
 *   plugins: [models, usage, credits, …]
 *   resources: { billing: { plans: { team: { title: "Team", credits: { perSeat: 10 } } } } }
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { checkAction, mayAction, priceListAction, spentAction } from "./actions/check.ts";
import {
  applyAction,
  budgetAction,
  grantAction,
  payAction,
  redeemAction,
  setPlanAction,
  settleAction,
  waiveAction,
} from "./actions/manage.ts";
import { noticeAction, stateAction } from "./actions/state.ts";
import { credit } from "./collections/credit.ts";
import { payment } from "./collections/payment.ts";
import { billingPlan } from "./collections/plan.ts";
import { billingRoom } from "./collections/room.ts";
import { DEFAULTS } from "./shared/settings.ts";

export type { Credit } from "./collections/credit.ts";
export type { Payment } from "./collections/payment.ts";
export type { Plan } from "./collections/plan.ts";
export type { CreditsSettings, PlanTerms } from "./shared/settings.ts";

export const credits: Plugin = definePlugin({
  name: "credits",
  requires: ["usage"],
  collections: { billingPlan, credit, payment, billingRoom },
  actions: {
    "billing.check": checkAction,
    "billing.may": mayAction,
    "billing.spent": spentAction,
    "billing.priceList": priceListAction,
    "billing.state": stateAction,
    "billing.notice": noticeAction,
    "billing.setPlan": setPlanAction,
    "billing.grant": grantAction,
    "billing.waive": waiveAction,
    "billing.pay": payAction,
    "billing.budget": budgetAction,
    "billing.redeem": redeemAction,
    "billing.apply": applyAction,
    "billing.settle": settleAction,
  },
  schedules: { "billing.settle": { cron: "20 0 * * *", call: "billing.settle", input: {} } },
  resources: {
    billing: DEFAULTS,
    usage: { priceList: "billing.priceList", spent: "billing.spent" },
    spending: { check: "billing.check", may: "billing.may" },
  },
});

export default credits;
