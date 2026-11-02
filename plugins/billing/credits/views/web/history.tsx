/**
 * What came in, newest first: credits (what they were, why, how much, when, and
 * when they lapse) and payments (what for, how much, when). A long list shows
 * its first few, the rest a press away. Nothing yet says what will show here.
 * Staff also see a payment's reference and what the channel kept, marked as
 * theirs; the org's people never see that.
 */
import { type ReactNode, useState } from "react";
import { Button, Card, EmptyState, Icon, Tabs } from "../../../../../hosts/web/mod.ts";
import {
  type BillingState,
  type CreditRow,
  dayShown,
  dollars,
  inCurrency,
  kindSaid,
  money,
  newestFirst,
  type PaymentRow,
  purposeSaid,
  whenShown,
} from "./numbers.ts";

const FIRST = 8;

export function History({ state }: { state: BillingState }): ReactNode {
  const credits = newestFirst(state.history ?? []);
  const payments = newestFirst(state.payments ?? []);
  const [which, setWhich] = useState<"credits" | "payments">("credits");
  const [all, setAll] = useState(false);
  const rows = which === "credits" ? credits : payments;
  const shown = all ? rows : rows.slice(0, FIRST);
  return (
    <Card as="section" className="billing-card billing-history" aria-labelledby="billing-history">
      <header className="billing-card-head billing-history-head">
        <h3 id="billing-history">History</h3>
        <Tabs
          label="Which history"
          value={which}
          onChange={(next) => {
            setWhich(next);
            setAll(false);
          }}
          tabs={[
            { value: "credits", label: "Credits", count: credits.length || undefined },
            { value: "payments", label: "Payments", count: payments.length || undefined },
          ]}
        />
      </header>
      {rows.length
        ? (
          <ul className="billing-rows">
            {which === "credits"
              ? (shown as CreditRow[]).map((row) => <CreditLine key={row._id} row={row} />)
              : (shown as PaymentRow[]).map((row) => (
                <PaymentLine key={row._id} row={row} staff={state.staff} />
              ))}
          </ul>
        )
        : (
          <EmptyState
            icon={which === "credits" ? "star" : "note"}
            heading="h3"
            title={which === "credits" ? "No credits yet" : "No payments yet"}
            className="billing-none"
          >
            {which === "credits"
              ? "Credits show here as they're added."
              : "What this org pays shows here, as it's paid."}
          </EmptyState>
        )}
      {rows.length > FIRST
        ? (
          <Button
            size="sm"
            variant="ghost"
            className="billing-more"
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        )
        : null}
    </Card>
  );
}

function CreditLine({ row }: { row: CreditRow }): ReactNode {
  // A plan's credits and a trial note the plan they came from; anything else, why it was given.
  const ofPlan = row.kind === "plan" || row.kind === "trial";
  const more = [
    row.note ? (ofPlan ? `${row.note} plan` : row.note) : null,
    row.expires ? `Lapses ${dayShown(row.expires)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="billing-row">
      <span className="billing-row-text">
        <b>{kindSaid(row.kind)}</b>
        {more ? <span className="billing-row-note">{more}</span> : null}
      </span>
      <span className="billing-row-end">
        <span className="billing-row-amount" data-way={row.amount < 0 ? "out" : "in"}>
          {row.amount < 0 ? money(row.amount) : `+${money(row.amount)}`}
        </span>
        <small>{whenShown(row.at)}</small>
      </span>
    </li>
  );
}

function PaymentLine({ row, staff }: { row: PaymentRow; staff: boolean }): ReactNode {
  const more = [
    row.note,
    row.credits
      ? `${dollars(Math.abs(row.credits))} of credits${row.credits < 0 ? " taken back" : ""}`
      : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="billing-row">
      <span className="billing-row-text">
        <b>{purposeSaid(row.purpose)}</b>
        {more ? <span className="billing-row-note">{more}</span> : null}
        {staff
          ? (
            <span className="billing-row-staff">
              <Icon name="shield" size={11} />
              {row.channel}: {row.ref}
              {row.fee !== undefined ? ` · kept ${inCurrency(row.fee, row.currency)}` : ""}
              {row.rate !== undefined ? ` · ${row.rate} USD each` : ""}
            </span>
          )
          : null}
      </span>
      <span className="billing-row-end">
        <span className="billing-row-amount" data-way={row.amount < 0 ? "out" : "paid"}>
          {inCurrency(row.amount, row.currency)}
        </span>
        <small>{whenShown(row.at)}</small>
      </span>
    </li>
  );
}
