/**
 * The org's billing (kind `billing.org`, a section of the org's page, the web
 * shell's `orgSettings`, at `/org?tab=billing`). People meet this when they're
 * running out, stopped mid-work, or paying, so it opens with what matters most:
 * what the org has left, what that's made of and the order it'll be spent in,
 * and if it can't go on, why, what stopped, and the way forward right there.
 * Then adding credits and redeeming a gift code, the plan, the month's budget,
 * and everything that came in. Coming back from paying, it says the payment is
 * being confirmed and reads again until it shows: it never claims what the
 * state doesn't show yet. An org that isn't charged says so, without numbers.
 * Anyone who doesn't run it sees only whether work can go on and who can help.
 * Platform staff also get their panel (staff.tsx), in the staff colour.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  Icon,
  IconButton,
  message,
  Notice,
  Skeleton,
  Spinner,
} from "../../../../../hosts/web/mod.ts";
import { AddCredits, Redeem } from "./add.tsx";
import { BudgetCard } from "./budget.tsx";
import { History } from "./history.tsx";
import {
  type Before,
  type BillingState,
  type Bucket,
  dayShown,
  kindSaid,
  landed,
  lapseSaid,
  lowOn,
  money,
  paidIn,
  pilesOf,
  teamOf,
  withoutPaid,
} from "./numbers.ts";
import { PlanCard, PlanOffers } from "./plan.tsx";
import { StaffPanel } from "./staff.tsx";
import { STYLE } from "./style.ts";
import { type Call, LEFT, type Org } from "./types.ts";

/** How long apart it reads again, confirming a payment: about half a minute in all. */
const TRIES = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000];

export const orgBillingView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <>
    <style href="billing-web" precedence="copilotz">{STYLE}</style>
    <Billing org={ctx.hints.org as Org | undefined} call={ctx.call} />
  </>
);

function Billing({ org, call }: { org?: Org; call: Call }): ReactNode {
  const [state, setState] = useState<BillingState>();
  const [error, setError] = useState<string>();
  const live = useRef(true);
  const read = useCallback(async () => {
    try {
      const answer = await call<BillingState>("billing.state", {});
      if (!live.current) return;
      setState(answer);
      setError(undefined);
    } catch (e) {
      if (live.current) setError(message(e));
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    // Coming back to the page, it's read again: credits go down as agents work.
    const again = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", again);
    return () => {
      live.current = false;
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  const payment = usePayment(state, read);

  if (error && !state) {
    return (
      <Notice
        tone="destructive"
        role="alert"
        action={<Button size="sm" onClick={() => void read()}>Try again</Button>}
      >
        We couldn't read this org's billing just now. {error}
      </Notice>
    );
  }
  if (!state) {
    return (
      <div className="billing" aria-busy="true">
        <Skeleton height={196} radius="xl" />
        <div className="billing-pair">
          <Skeleton height={228} radius="xl" />
          <Skeleton height={228} radius="xl" />
        </div>
        <Skeleton height={180} radius="xl" />
      </div>
    );
  }
  if (!state.on && !state.staff) {
    return (
      <div className="billing">
        <Card className="billing-calm">
          <span className="billing-calm-icon">
            <Icon name="check-circle" size={20} />
          </span>
          <div>
            <h3>Nothing's charged for this org yet</h3>
            <p>Everyone here can keep working as usual.</p>
          </div>
        </Card>
      </div>
    );
  }
  if (!state.runs) return <ForMembers state={state} org={org} />;

  const personal = org?.kind === "personal";
  const team = teamOf(document.title);
  const quiet = payment.phase === "waiting" || payment.phase === "late";
  // What stopped them, or soon will, comes straight after the balance.
  const budgetFirst = state.why === "budget" || lowOn(state) === "budget" ||
    state.plan?.status === "past_due";
  const staffPanel = state.staff
    ? <StaffPanel state={state} org={org} call={call} onChanged={read} />
    : null;
  const planAndBudget = (
    <div
      className="billing-pair billing-pair-even"
      data-budget-first={(budgetFirst && state.plan?.status !== "past_due") || undefined}
    >
      <PlanCard state={state} team={team} call={call} />
      <BudgetCard state={state} call={call} onChanged={read} />
    </div>
  );
  return (
    <div className="billing">
      {!state.on
        ? (
          <Notice tone="warning" icon="shield" title="Limits are off for the whole app">
            Nobody is charged or stopped, in any org, and nothing starts by itself: no plans, trials
            or balances. What you set below is kept for when they're turned on.
          </Notice>
        )
        : null}
      <PaymentNotice payment={payment} />
      {state.on
        ? (
          <>
            <Balance
              state={state}
              personal={personal}
              team={team}
              quiet={quiet}
            />
            {staffPanel}
            {budgetFirst ? planAndBudget : null}
            <div className="billing-pair" data-single={state.waived || undefined}>
              {state.waived ? null : <AddCredits state={state} team={team} call={call} />}
              <Redeem call={call} onRedeemed={read} />
            </div>
            {budgetFirst ? null : planAndBudget}
            <PlanOffers state={state} call={call} />
            <History state={state} />
          </>
        )
        : staffPanel}
      {error
        ? (
          <Notice
            tone="neutral"
            action={<Button size="sm" onClick={() => void read()}>Try again</Button>}
          >
            This may be a moment out of date: we couldn't read it again just now.
          </Notice>
        )
        : null}
    </div>
  );
}

/** Someone who doesn't run the org: whether work can go on, and who can help. */
export function ForMembers({ state, org }: { state: BillingState; org?: Org }): ReactNode {
  const name = org?.name ?? "This org";
  if (state.ok === false) {
    return (
      <div className="billing">
        <Notice
          tone="warning"
          title={state.why === "budget"
            ? `${name} has reached its budget for the month`
            : `${name} is out of credits`}
        >
          Agents can't run until there's more. Nothing is deleted. Its owners and admins can{" "}
          {state.why === "budget" ? "raise it" : "add more"}.
        </Notice>
      </div>
    );
  }
  return (
    <div className="billing">
      <Card className="billing-calm">
        <span className="billing-calm-icon">
          <Icon name="check-circle" size={20} />
        </span>
        <div>
          <h3>All good</h3>
          <p>{name}'s owners and admins look after its billing.</p>
        </div>
      </Card>
    </div>
  );
}

/** What's scrolled to, and given focus, for the way forward named at the top. */
const toSection = (id: string, focus: string) => {
  const section = document.getElementById(id);
  section?.scrollIntoView({ behavior: "smooth", block: "center" });
  section?.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
};

const addCredits = () => toSection("billing-add", "input:checked, input, button");
const changeBudget = () => toSection("billing-budget", "button");

/** The balance first: the number, then what it's made of, in the order it'll be spent. */
export function Balance(
  { state, personal, team, quiet }: {
    state: BillingState;
    personal: boolean;
    team: string;
    /** A payment is being confirmed: not the moment to say they're out. */
    quiet: boolean;
  },
): ReactNode {
  const balance = state.balance ?? 0;
  const debt = state.debt ?? 0;
  const buckets = state.buckets ?? [];
  if (state.waived) {
    const until = state.plan?.waived?.usage?.until;
    return (
      <Card as="section" className="billing-calm billing-waived" aria-label="Balance">
        <span className="billing-calm-icon">
          <Icon name="check-circle" size={20} />
        </span>
        <div>
          <h3>Usage isn't charged</h3>
          <p>
            Agents and computers run without using any credits
            {until ? `, until ${dayShown(until)}` : ""}.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card
      as="section"
      className="billing-balance"
      aria-labelledby="billing-balance"
      data-stopped={state.ok === false || undefined}
    >
      {quiet ? null : <Standing state={state} personal={personal} team={team} />}
      <div className="billing-balance-grid">
        <div className="billing-balance-main">
          <h3 id="billing-balance" className="billing-label">Balance</h3>
          <p className="billing-amount" data-negative={balance < 0 || undefined}>
            {money(balance)}
          </p>
          {debt > 0
            ? (
              <p className="billing-debt">
                The last work went {money(debt)}{" "}
                past what was left. The next credits cover that first.
              </p>
            )
            : null}
          <p className="billing-worth">$1 of credits pays for $1 of usage, at the listed prices.</p>
        </div>
        {buckets.length ? <Buckets buckets={buckets} /> : null}
      </div>
    </Card>
  );
}

/** Why the org can't go on, or soon won't: what stopped, and what to do, in its place. */
function Standing(
  { state, personal, team }: { state: BillingState; personal: boolean; team: string },
): ReactNode {
  const month = state.month;
  const pay = state.pay;
  const resets = month ? dayShown(month.end) : "";
  if (state.ok === false && state.why === "budget") {
    return (
      <Notice
        tone="warning"
        role="status"
        className="billing-standing billing-wrap"
        title={`${personal ? "You've" : "This org has"} reached this month's ${
          month?.limit !== undefined ? `${money(month.limit)} ` : ""
        }budget`}
        action={<Button size="sm" variant="primary" onClick={changeBudget}>Change budget</Button>}
      >
        Agents have stopped and computers are asleep. Nothing is deleted. It resets{" "}
        {resets}, or raise it to carry on now.
      </Notice>
    );
  }
  if (state.ok === false) {
    return (
      <Notice
        tone="warning"
        role="status"
        className="billing-standing billing-wrap"
        title={`${personal ? "You're" : "This org is"} out of credits`}
        action={pay
          ? <Button size="sm" variant="primary" onClick={addCredits}>Add credits</Button>
          : undefined}
      >
        Agents have stopped and computers are asleep. Nothing is deleted. {pay
          ? "Add credits and you can carry on right away."
          : `Credits come from ${team}: once they add more, you can carry on.`}
      </Notice>
    );
  }
  const low = lowOn(state);
  if (low === "budget" && month?.limit !== undefined) {
    return (
      <Notice
        tone="neutral"
        icon="info"
        role="status"
        className="billing-standing billing-wrap"
        title={`${money(Math.max(month.limit - month.spent, 0))} left of this month's budget`}
        action={<Button size="sm" onClick={changeBudget}>Change budget</Button>}
      >
        At the limit, agents stop and computers sleep until {resets}.
      </Notice>
    );
  }
  if (low === "credits") {
    return (
      <Notice
        tone="neutral"
        icon="info"
        role="status"
        className="billing-standing billing-wrap"
        title="Running low on credits"
        action={pay ? <Button size="sm" onClick={addCredits}>Add credits</Button> : undefined}
      >
        {pay
          ? "Add some now and nobody gets stopped mid-work."
          : `Credits come from ${team}: ask them for more before they run out.`}
      </Notice>
    );
  }
  return null;
}

/** Each kind of credit in one colour of the theme's, wherever it shows. */
const COLOURS: Record<string, number> = {
  plan: 1,
  trial: 5,
  gift: 3,
  referral: 3,
  purchase: 2,
  waived: 4,
  adjustment: 4,
};

/** The credits there are, as one bar and a list, in the order they'll be spent. */
function Buckets({ buckets: given }: { buckets: Bucket[] }): ReactNode {
  const piles = pilesOf(given);
  const whole = piles.reduce((sum, pile) => sum + pile.left, 0);
  return (
    <div className="billing-buckets">
      <h4 className="billing-label">{piles.length > 1 ? "Spent in this order" : "Made up of"}</h4>
      {piles.length > 1
        ? (
          <div className="billing-stack" aria-hidden="true">
            {piles.map((bucket) => (
              <span
                key={bucket.id}
                data-colour={COLOURS[bucket.kind] ?? 4}
                style={{ flexGrow: bucket.left / whole }}
              />
            ))}
          </div>
        )
        : null}
      <ol className="billing-bucket-list">
        {piles.map((bucket) => (
          <li key={bucket.id}>
            <i data-colour={COLOURS[bucket.kind] ?? 4} aria-hidden="true" />
            <span className="billing-bucket-name">
              {kindSaid(bucket.kind)}
              <small>{lapseSaid(bucket.expires)}</small>
            </span>
            <span className="billing-bucket-left">
              {money(bucket.left)}
              {Math.abs(bucket.left - bucket.amount) > 0.005
                ? <small>of {money(bucket.amount)}</small>
                : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A payment coming back: being confirmed, confirmed, or not shown yet. */
type Payment = {
  phase: "none" | "waiting" | "done" | "late";
  thanks?: string;
  again(): void;
  dismiss(): void;
};

const keptBefore = (): Before | undefined => {
  try {
    const kept = sessionStorage.getItem(LEFT);
    return kept ? JSON.parse(kept) as Before : undefined;
  } catch {
    return undefined;
  }
};

const forgetBefore = () => {
  try {
    sessionStorage.removeItem(LEFT);
  } catch { /* Nothing was kept. */ }
};

/**
 * Coming back with `?paid=`: what was bought lands by the payment provider's
 * word, which may come a moment later, so it reads again until the state shows
 * it, a few times, and then says plainly it isn't showing yet.
 */
function usePayment(state: BillingState | undefined, read: () => Promise<void>): Payment {
  const [paid] = useState(() => paidIn(globalThis.location?.search ?? ""));
  const [before] = useState(keptBefore);
  const [phase, setPhase] = useState<Payment["phase"]>(paid ? "waiting" : "none");
  const [thanks, setThanks] = useState<string>();
  useEffect(() => {
    if (!paid || !state || phase === "done" || phase === "none") return;
    const said = landed(state, paid, before);
    if (!said) return;
    setThanks(said);
    setPhase("done");
    forgetBefore();
    // Read again later, this page doesn't confirm it twice.
    history.replaceState(history.state, "", location.pathname + withoutPaid(location.search));
  }, [state, phase]);
  useEffect(() => {
    if (phase !== "waiting") return;
    let timer: ReturnType<typeof setTimeout>;
    let current = true;
    const next = (at: number) => {
      if (at >= TRIES.length) return setPhase("late");
      timer = setTimeout(async () => {
        await read();
        if (current) next(at + 1);
      }, TRIES[at]);
    };
    next(0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [phase]);
  return {
    phase,
    thanks,
    again: () => setPhase("waiting"),
    dismiss: () => setPhase("none"),
  };
}

function PaymentNotice({ payment }: { payment: Payment }): ReactNode {
  if (payment.phase === "waiting") {
    return (
      <Notice tone="info" icon={false} role="status" className="billing-paying">
        <span className="billing-paying-line">
          <Spinner size={15} />
          <span>
            <b>Confirming your payment…</b>{" "}
            This usually takes a few seconds. You can stay here or get back to work.
          </span>
        </span>
      </Notice>
    );
  }
  if (payment.phase === "late") {
    return (
      <Notice
        tone="neutral"
        role="status"
        className="billing-wrap"
        title="Your payment isn't showing yet"
        action={<Button size="sm" onClick={payment.again}>Check again</Button>}
      >
        If you paid, it'll land here soon: there's no need to pay again. Sometimes a bank takes a
        little longer.
      </Notice>
    );
  }
  if (payment.phase === "done") {
    return (
      <Notice
        tone="success"
        role="status"
        title="Thank you"
        action={<IconButton icon="close" size="sm" label="Dismiss" onClick={payment.dismiss} />}
      >
        {payment.thanks}
      </Notice>
    );
  }
  return null;
}
