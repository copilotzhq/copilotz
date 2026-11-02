/**
 * The org's plan: its name, what it includes, its seats and this period's
 * dates. If the last payment failed, it says so and how to fix it: what they
 * have still works, and new plan credits wait until it's sorted. Beside it (a
 * card of its own, `PlanOffers`): the plans they can move to, each with its price
 * a seat and the total for their seats shown before they go, then a payment page
 * where they confirm. Already subscribed, those changes happen in "Manage
 * billing", the payment provider's own page (card, invoices, cancelling).
 */
import type { ReactNode } from "react";
import { Badge, Button, Card, Notice } from "../../../../../hosts/web/mod.ts";
import { leavingFor, useBackFromLeaving } from "./add.tsx";
import {
  type BillingState,
  dayShown,
  includes,
  type Offer,
  periodShown,
  priceFor,
  seatsSaid,
} from "./numbers.ts";
import { type Call, useAct } from "./types.ts";

export function PlanCard(
  { state, team, call }: { state: BillingState; team: string; call: Call },
): ReactNode {
  const plan = state.plan;
  const pay = state.pay;
  const manage = useAct();
  useBackFromLeaving(manage.release);
  if (!plan) return null;
  const pastDue = plan.status === "past_due";
  const ended = plan.status === "canceled";
  const subscribed = !!plan.subscription && !ended;
  const perSeat = !!plan.terms.seat || !!plan.terms.credits?.perSeat ||
    plan.fixedSeats !== undefined;
  const open = () =>
    void manage.run(async () => {
      const { url } = await call<{ url: string }>("billing.portal", {});
      leavingFor(url, state);
    }, true);
  const said = includes(plan.terms, state.seats);
  return (
    <Card as="section" className="billing-card" aria-labelledby="billing-plan">
      <header className="billing-card-head">
        <h3 id="billing-plan">Plan</h3>
        {pastDue
          ? <Badge tone="warning">Payment failed</Badge>
          : ended
          ? <Badge>Ended</Badge>
          : null}
      </header>
      <p className="billing-plan-name">{plan.terms.title}</p>
      {pastDue
        ? (
          <Notice
            tone="warning"
            role="status"
            className="billing-wrap"
            title="The last payment didn't go through"
            action={pay?.manage
              ? (
                <Button size="sm" variant="primary" loading={manage.busy} onClick={open}>
                  Fix payment
                </Button>
              )
              : undefined}
          >
            What you have still works. New plan credits wait until it's sorted.
            {pay?.manage ? "" : ` Ask ${team} for help.`}
          </Notice>
        )
        : null}
      <dl className="billing-facts">
        {said.length
          ? (
            <div>
              <dt>Includes</dt>
              <dd>{said.join(" · ")}</dd>
            </div>
          )
          : null}
        {perSeat && state.seats !== undefined
          ? (
            <div>
              <dt>Seats</dt>
              <dd>
                {seatsSaid(plan.fixedSeats ?? Math.max(state.seats, 1))}
                <small>
                  {plan.fixedSeats !== undefined
                    ? " · set by your contract"
                    : " · guests don't count"}
                </small>
              </dd>
            </div>
          )
          : null}
        {state.period
          ? (
            <div>
              <dt>This period</dt>
              <dd>
                {periodShown(state.period)}
                {pastDue || ended ? null : <small>· renews {dayShown(state.period.end)}</small>}
              </dd>
            </div>
          )
          : null}
      </dl>
      {subscribed && pay?.manage
        ? <p className="billing-small">To change or cancel your plan, use Manage billing.</p>
        : null}
      {pay?.manage && !pastDue
        ? (
          <div className="billing-card-end">
            <Button icon="external" loading={manage.busy} onClick={open}>Manage billing</Button>
            <span className="billing-small">Card, invoices and cancelling.</span>
          </div>
        )
        : null}
      {manage.error ? <Notice tone="destructive" role="alert">{manage.error}</Notice> : null}
    </Card>
  );
}

/** The plans they can move to; none while a subscription runs (that's Manage billing's). */
export function PlanOffers({ state, call }: { state: BillingState; call: Call }): ReactNode {
  const plan = state.plan;
  const offers = (state.pay?.plans ?? []).filter((offer) => offer.name !== plan?.name);
  const subscribed = !!plan?.subscription && plan.status !== "canceled";
  // On a contract, moving is a conversation, and what a checkout charges isn't its seats.
  if (!offers.length || subscribed || plan?.fixedSeats !== undefined) return null;
  return (
    <Card as="section" className="billing-card" aria-labelledby="billing-offers">
      <header className="billing-card-head">
        <h3 id="billing-offers">Move to a plan</h3>
        <p className="billing-small">You'll confirm on a secure payment page before you pay.</p>
      </header>
      <ul className="billing-offers">
        {offers.map((offer) => (
          <OfferRow
            key={offer.name}
            offer={offer}
            state={state}
            call={call}
          />
        ))}
      </ul>
    </Card>
  );
}

/** A plan they can move to: what it costs them, before they go. */
function OfferRow(
  { offer, state, call }: { offer: Offer; state: BillingState; call: Call },
): ReactNode {
  const { busy, error, run, release } = useAct();
  useBackFromLeaving(release);
  const price = priceFor(offer.seat, state.billedSeats ?? state.seats);
  const gets = includes(offer, state.seats);
  return (
    <li className="billing-offer">
      <div className="billing-offer-text">
        <b>{offer.title}</b>
        <span className="billing-offer-total">{price.total}</span>
        <span>{price.each}</span>
        {gets.length ? <span>{gets.join(" · ")}</span> : null}
      </div>
      <Button
        className="billing-go"
        loading={busy}
        onClick={() =>
          void run(async () => {
            const { url } = await call<{ url: string }>("billing.checkout", { plan: offer.name });
            leavingFor(url, state);
          }, true)}
      >
        Move to {offer.title}
      </Button>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </li>
  );
}
