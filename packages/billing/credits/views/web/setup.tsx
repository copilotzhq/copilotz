/**
 * Choosing a plan as a team org starts (kind `billing.setup`, a step of chat's
 * `welcome` for owners and admins of team orgs): a team org comes with no
 * credits, so its agents wait for a plan. Its plans, each with what it comes
 * to for its seats and what it gives, and a payment page that comes back to
 * the welcome (`/?welcome=1`). Already on one, it says so; where paying isn't
 * set up, it says who adds credits.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "copilotz";
import { message, Notice, Skeleton } from "copilotz/web";
import type { BillingState } from "./numbers.ts";
import { PlanOffers } from "./plan.tsx";
import { STYLE } from "./style.ts";
import type { Call } from "./types.ts";

export const billingSetupView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <>
    <style href="billing-web" precedence="copilotz">{STYLE}</style>
    <Setup call={ctx.call} />
  </>
);

function Setup({ call }: { call: Call }): ReactNode {
  const [state, setState] = useState<BillingState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    call<BillingState>("billing.state", {}).then(
      (answer) => live && setState(answer),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  if (error) return <Notice tone="destructive" role="alert">{error}</Notice>;
  if (!state) return <Skeleton height={160} radius="lg" />;
  const plan = state.plan;
  const subscribed = !!plan?.subscription && plan.status !== "canceled";
  if (subscribed || (plan && plan.name !== "free" && (state.balance ?? 0) > 0)) {
    return (
      <Notice tone="success" icon="check">
        <b>You're on {plan?.terms?.title ?? "a plan"}.</b>{" "}
        Your agents can work: each seat's price comes back as credits every month.
      </Notice>
    );
  }
  const offers = state.pay?.plans ?? [];
  if (!offers.length) {
    return (
      <Notice tone="neutral" icon="info">
        Paying online isn't set up here yet. Credits can be added in Billing, under your org's
        settings.
      </Notice>
    );
  }
  return (
    <div className="billing-setup">
      <p className="billing-small">
        A team org starts with no credits. On a plan, each seat's price comes back as credits every
        month, shared by everyone here, and you can change or cancel it any time.
      </p>
      <PlanOffers state={state} call={call} back="/?welcome=1" title="Plans for teams" />
    </div>
  );
}
