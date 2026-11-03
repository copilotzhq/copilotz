/**
 * The org's plan: its name, what's left of this period's plan credits and the
 * day they end (what's left then doesn't carry over), what it includes, its
 * seats and this period's dates. If the last payment failed, it says so and how
 * to fix it: what they have still works, and new plan credits wait until it's
 * sorted. Beside it (a card of its own, `PlanOffers`): the plans they can move
 * to, those for their kind of org first, each with its price a seat and the
 * total for their seats shown before they go, then a payment page where they
 * confirm; in a personal org, that a team's plan is for team orgs. Already
 * subscribed, those changes happen in "Manage billing", the payment provider's
 * own page (card, invoices, cancelling).
 */
import type { ReactNode } from "react";
import { Badge, Button, Card, Icon, Notice } from "../../../../../hosts/web/mod.ts";
import { leavingFor, useBackFromLeaving } from "./add.tsx";
import {
  type BillingState,
  dayShown,
  includes,
  inCurrency,
  type Offer,
  periodShown,
  planCredits,
  planCreditsSaid,
  priceFor,
  seatsSaid,
} from "./numbers.ts";
import { type Call, useAct } from "./types.ts";

export function PlanCard(
  { state, team, personal = false, call }: {
    state: BillingState;
    team: string;
    /** A personal org: one person, so no seats to speak of. */
    personal?: boolean;
    call: Call;
  },
): ReactNode {
  const plan = state.plan;
  const pay = state.pay;
  const manage = useAct();
  useBackFromLeaving(manage.release);
  if (!plan) return null;
  const pastDue = plan.status === "past_due";
  const ended = plan.status === "canceled";
  const subscribed = !!plan.subscription && !ended;
  const perSeat = plan.fixedSeats !== undefined ||
    (!personal && (!!plan.terms.seat || !!plan.terms.credits?.perSeat));
  const open = () =>
    void manage.run(async () => {
      const { url } = await call<{ url: string }>("billing.portal", {});
      leavingFor(url, state);
    }, true);
  const said = includes(plan.terms, state.seats, personal);
  const credits = planCredits(state);
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
      {credits ? <PlanCredits credits={credits} renews={!pastDue && !ended} /> : null}
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

/** This period's plan credits: what's left, until when, as a meter that empties. */
function PlanCredits(
  { credits, renews }: {
    credits: { amount: number; left: number; until: string };
    renews: boolean;
  },
): ReactNode {
  const said = planCreditsSaid(credits, renews);
  const share = credits.amount > 0 ? credits.left / credits.amount : 0;
  return (
    <div className="billing-plan-credits">
      <p className="billing-plan-left">{said.title}</p>
      <div
        className="billing-meter"
        role="meter"
        aria-label="This month's plan credits left"
        aria-valuemin={0}
        aria-valuemax={credits.amount}
        aria-valuenow={Math.round(credits.left * 100) / 100}
      >
        <span style={{ width: `${Math.round(share * 1000) / 10}%` }} />
      </div>
      <p className="billing-small">{said.more}</p>
    </div>
  );
}

/** The plans they can move to; none while a subscription runs (that's Manage billing's). */
export function PlanOffers(
  { state, personal = false, call }: { state: BillingState; personal?: boolean; call: Call },
): ReactNode {
  const plan = state.plan;
  const offers = (state.pay?.plans ?? []).filter((offer) => offer.name !== plan?.name);
  // A personal org isn't offered a team's plan: it's told where that is instead.
  const forTeams = (state.pay?.elsewhere ?? []).filter((offer) => offer.for === "team");
  const subscribed = !!plan?.subscription && plan.status !== "canceled";
  // On a contract, moving is a conversation, and what a checkout charges isn't its seats.
  if ((!offers.length && !forTeams.length) || subscribed || plan?.fixedSeats !== undefined) {
    return null;
  }
  return (
    <Card as="section" className="billing-card" aria-labelledby="billing-offers">
      <header className="billing-card-head">
        <h3 id="billing-offers">{offers.length ? "Move to a plan" : "Plans"}</h3>
        {offers.length
          ? <p className="billing-small">You'll confirm on a secure payment page before you pay.</p>
          : null}
      </header>
      {offers.length
        ? (
          <ul className="billing-offers">
            {offers.map((offer) => (
              <OfferRow
                key={offer.name}
                offer={offer}
                state={state}
                personal={personal}
                call={call}
              />
            ))}
          </ul>
        )
        : null}
      {forTeams.length ? <ForTeams offers={forTeams} /> : null}
    </Card>
  );
}

/** A team's plans, said to a personal org: what they are, and that a team org takes them. */
function ForTeams({ offers }: { offers: Offer[] }): ReactNode {
  const names = offers.map((offer) =>
    `${offer.title} (${inCurrency(offer.seat.price, offer.seat.currency)} a seat a month)`
  );
  return (
    <p className="billing-small billing-for-teams">
      <Icon name="users" size={14} />
      <span>
        Working with others? {names.join(" and ")} {offers.length === 1 ? "is" : "are"}{" "}
        for team orgs: make one from the org switcher, and choose it in that org's Billing.
      </span>
    </p>
  );
}

/** A plan they can move to: what it costs them, before they go. */
function OfferRow(
  { offer, state, personal, call }: {
    offer: Offer;
    state: BillingState;
    personal: boolean;
    call: Call;
  },
): ReactNode {
  const { busy, error, run, release } = useAct();
  useBackFromLeaving(release);
  const price = priceFor(offer.seat, state.billedSeats ?? state.seats, personal);
  const gets = includes(offer, state.seats, personal);
  return (
    <li className="billing-offer">
      <div className="billing-offer-text">
        <b>{offer.title}</b>
        <span className="billing-offer-total">{price.total}</span>
        {price.each ? <span>{price.each}</span> : null}
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
