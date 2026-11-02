/**
 * Adding to what the org has. **Add credits:** a few amounts to choose from, or
 * one of their own within the limits; what the balance comes to after, any
 * debt paid first; then a page of the payment provider's, where they confirm:
 * the card never reaches the app. If it fails, why, with what they chose kept.
 * Where nothing can be bought here, it says who credits come from, with no dead
 * buttons. **Gift code:** typed in, what it added; if it isn't good, why, right
 * there, with what was typed kept.
 */
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Button, Card, Field, Icon, Input, Notice } from "../../../../../hosts/web/mod.ts";
import {
  balanceAfter,
  beforeOf,
  type BillingState,
  dayShown,
  dollars,
  money,
  topUpOf,
} from "./numbers.ts";
import { type Call, LEFT, useAct } from "./types.ts";

/** Leaving for a payment page: what's here now is kept, to tell on coming back what's new. */
export function leavingFor(url: string, state: BillingState): void {
  try {
    sessionStorage.setItem(LEFT, JSON.stringify(beforeOf(state)));
  } catch { /* Coming back, it goes by how recent a payment is. */ }
  location.assign(url);
}

/** A button left busy on leaving is released on coming back through the browser's Back. */
export function useBackFromLeaving(release: () => void): void {
  useEffect(() => {
    const back = (event: PageTransitionEvent) => event.persisted && release();
    addEventListener("pageshow", back);
    return () => removeEventListener("pageshow", back);
  }, []);
}

export function AddCredits(
  { state, team, call }: { state: BillingState; team: string; call: Call },
): ReactNode {
  const pay = state.pay;
  const id = useId();
  const options = pay?.topUps ?? [];
  const [choice, setChoice] = useState<number | "other">(options[1] ?? options[0] ?? "other");
  const [typed, setTyped] = useState("");
  const { busy, error, run, release } = useAct();
  useBackFromLeaving(release);

  if (!pay) {
    return (
      <Card as="section" className="billing-card" id="billing-add" aria-labelledby={`${id}-head`}>
        <header className="billing-card-head">
          <h3 id={`${id}-head`}>Add credits</h3>
        </header>
        <p className="billing-text">
          Credits here come from {team}. Ask them for more and they'll show up on this page.
        </p>
      </Card>
    );
  }

  const parsed = choice === "other" ? topUpOf(typed, pay) : { amount: choice };
  const amount = "amount" in parsed ? parsed.amount : undefined;
  const wrong = choice === "other" && typed.trim() && "error" in parsed ? parsed.error : undefined;
  const after = amount === undefined ? undefined : balanceAfter(state.balance ?? 0, amount);
  const go = (event: FormEvent) => {
    event.preventDefault();
    if (amount === undefined || busy) return;
    void run(async () => {
      const { url } = await call<{ url: string }>("billing.checkout", { credits: amount });
      leavingFor(url, state);
    }, true);
  };
  return (
    <Card as="section" className="billing-card" id="billing-add" aria-labelledby={`${id}-head`}>
      <header className="billing-card-head">
        <h3 id={`${id}-head`}>Add credits</h3>
      </header>
      <form className="billing-add" onSubmit={go}>
        <div className="billing-choices" role="radiogroup" aria-labelledby={`${id}-head`}>
          {options.map((option) => (
            <label key={option} className="billing-choice" data-on={choice === option || undefined}>
              <input
                type="radio"
                name={`${id}-amount`}
                checked={choice === option}
                disabled={busy}
                onChange={() =>
                  setChoice(option)}
              />
              {dollars(option)}
            </label>
          ))}
          <label className="billing-choice" data-on={choice === "other" || undefined}>
            <input
              type="radio"
              name={`${id}-amount`}
              checked={choice === "other"}
              disabled={busy}
              onChange={() =>
                setChoice("other")}
            />
            Other
          </label>
        </div>
        {choice === "other"
          ? (
            <Field
              label="Amount"
              hint={`Between ${dollars(pay.min)} and ${dollars(pay.max)}.`}
              error={wrong}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={typed}
                  disabled={busy}
                  autoFocus
                  className="billing-money-input"
                  onChange={(event) => setTyped(event.target.value)}
                />
              )}
            </Field>
          )
          : null}
        <p className="billing-after" aria-live="polite">
          {after !== undefined
            ? (
              <>
                Your balance will be <b>{money(after)}</b>
              </>
            )
            : " "}
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={amount === undefined}
          className="billing-go"
        >
          {busy
            ? "Opening the payment page…"
            : amount !== undefined
            ? `Continue to pay ${dollars(amount)}`
            : "Continue to payment"}
        </Button>
        <p className="billing-small">
          <Icon name="lock" size={13} />
          You'll confirm on a secure payment page. Credits you buy never lapse, and they're spent
          last.
        </p>
      </form>
    </Card>
  );
}

export function Redeem(
  { call, onRedeemed }: { call: Call; onRedeemed(): Promise<void> },
): ReactNode {
  const [code, setCode] = useState("");
  const [added, setAdded] = useState<{ amount: number; expires?: string }>();
  const { busy, error, run, clear } = useAct();
  const typed = code.trim();
  const go = (event: FormEvent) => {
    event.preventDefault();
    if (!typed || busy) return;
    void run(async () => {
      const answer = await call<{ amount: number; expires?: string }>("billing.redeem", {
        code: typed,
      });
      setAdded(answer);
      setCode("");
      await onRedeemed();
    });
  };
  return (
    <Card as="section" className="billing-card" aria-labelledby="billing-redeem">
      <header className="billing-card-head">
        <h3 id="billing-redeem">Gift code</h3>
      </header>
      <form className="billing-redeem" onSubmit={go}>
        <Field
          label="Have a code? Type it here"
          error={error}
          hint={error ? undefined : "Its credits go to this org, for everyone here to use."}
        >
          {(control) => (
            <Input
              {...control}
              value={code}
              spellCheck={false}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="GIFT-XXXXX-XXXXX"
              className="billing-code-input"
              onChange={(event) => {
                setCode(event.target.value);
                setAdded(undefined);
                clear();
              }}
            />
          )}
        </Field>
        <Button type="submit" loading={busy} disabled={!typed} className="billing-go-small">
          Redeem
        </Button>
        {added
          ? (
            <Notice tone="success" role="status">
              <b>{money(added.amount)} added.</b> {added.expires
                ? `They lapse ${
                  dayShown(added.expires)
                }, and they're spent before what lasts longer.`
                : "They don't lapse."}
            </Notice>
          )
          : null}
      </form>
    </Card>
  );
}
