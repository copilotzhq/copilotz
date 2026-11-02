/**
 * This month's budget: what's been spent against its limit as a meter, until
 * when, and changing it (or having none). Before they set one, it says what
 * happens at the limit: agents stop and computers sleep, nothing is deleted,
 * and it resets next month; and if what they typed is under what's been spent
 * already, that work stops right away. Near the limit the meter says so in
 * words as well as colour; at it, plainly.
 */
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Field,
  Icon,
  Input,
  Notice,
} from "../../../../../hosts/web/mod.ts";
import { amountOf, type BillingState, budgetStand, dayShown, money } from "./numbers.ts";
import { type Call, useAct } from "./types.ts";

export function BudgetCard(
  { state, call, onChanged }: { state: BillingState; call: Call; onChanged(): Promise<void> },
): ReactNode {
  const [changing, setChanging] = useState(false);
  const stand = budgetStand(state);
  const month = state.month;
  if (!month) return null;
  // An org that isn't charged has no limit to think about, unless one was set.
  if (state.waived && stand.tone === "none") return null;
  const resets = dayShown(month.end);
  return (
    <Card as="section" className="billing-card" id="billing-budget" aria-labelledby="billing-month">
      <header className="billing-card-head">
        <h3 id="billing-month">This month's budget</h3>
        {stand.tone === "at"
          ? <Badge tone="warning">Limit reached</Badge>
          : stand.tone === "near"
          ? <Badge tone="warning">Near the limit</Badge>
          : null}
      </header>
      {stand.limit !== undefined
        ? (
          <>
            <p className="billing-spent">
              <b>{money(stand.spent)}</b> of {money(stand.limit)}
            </p>
            <div
              className="billing-meter"
              data-tone={stand.tone}
              role="meter"
              aria-label="Spent this month, against the limit"
              aria-valuemin={0}
              aria-valuemax={stand.limit}
              aria-valuenow={Math.min(stand.spent, stand.limit)}
              aria-valuetext={`${money(stand.spent)} of ${money(stand.limit)}`}
            >
              <span
                style={{ width: `${Math.max(stand.share * 100, stand.spent > 0 ? 1.5 : 0)}%` }}
              />
            </div>
            <p className="billing-text">
              {stand.tone === "at"
                ? `It resets ${resets}, or raise it to carry on now.`
                : `${money(stand.left ?? 0)} left. Resets ${resets}.`}
            </p>
          </>
        )
        : (
          <>
            <p className="billing-spent">
              <b>{money(stand.spent)}</b> so far
            </p>
            <p className="billing-text">
              No limit: agents can use what credits you have. A new month starts {resets}.
            </p>
          </>
        )}
      <div className="billing-card-end">
        <Button
          variant={stand.tone === "at" ? "primary" : "outline"}
          onClick={() =>
            setChanging(true)}
        >
          {stand.limit === undefined ? "Set a limit" : "Change budget"}
        </Button>
      </div>
      <BudgetDialog
        open={changing}
        close={() =>
          setChanging(false)}
        limit={stand.limit}
        spent={stand.spent}
        resets={resets}
        call={call}
        onChanged={onChanged}
      />
    </Card>
  );
}

function BudgetDialog(
  { open, close, limit, spent, resets, call, onChanged }: {
    open: boolean;
    close(): void;
    limit?: number;
    spent: number;
    resets: string;
    call: Call;
    onChanged(): Promise<void>;
  },
): ReactNode {
  const [none, setNone] = useState(false);
  const [typed, setTyped] = useState("");
  const { busy, error, run, clear } = useAct();
  useEffect(() => {
    if (!open) return;
    setNone(false);
    setTyped(limit === undefined ? "" : String(limit));
    clear();
  }, [open]);
  const amount = amountOf(typed);
  const wrong = !none && typed.trim() && amount === undefined ? "That isn't an amount." : undefined;
  const valid = none || amount !== undefined;
  const stops = !none && amount !== undefined && amount <= spent;
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!valid || busy) return;
    void run(async () => {
      await call("billing.budget", { usd: none ? null : amount });
      await onChanged();
      close();
    });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="This month's budget"
      description={`${money(spent)} spent so far. It starts over ${resets}.`}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => save()}>
            {none ? "Remove the limit" : amount !== undefined ? `Set to ${money(amount)}` : "Save"}
          </Button>
        </>
      }
    >
      <form className="billing-dialog" onSubmit={save}>
        <Field label="Limit for a month" error={wrong}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              placeholder="50"
              disabled={none}
              className="billing-money-input"
              value={none ? "" : typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          )}
        </Field>
        <Checkbox
          label="No limit: use whatever credits there are"
          checked={none}
          onChange={(event) => setNone(event.target.checked)}
        />
        {stops
          ? (
            <Notice tone="warning" role="status">
              That's no more than what's already been spent, so work stops right away, until{" "}
              {resets} or until you raise it.
            </Notice>
          )
          : null}
        <ul className="billing-rules">
          <li>
            <Icon name="pause" size={14} />
            At the limit, agents stop and computers sleep.
          </li>
          <li>
            <Icon name="lock" size={14} />
            Nothing is deleted.
          </li>
          <li>
            <Icon name="refresh" size={14} />
            It resets {resets}, and every month after.
          </li>
        </ul>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
