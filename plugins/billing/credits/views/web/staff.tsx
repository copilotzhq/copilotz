/**
 * What platform staff do with an org's billing, in the staff colour and marked
 * as theirs: where it stands now (its plan, how it pays, any waiver, who waived
 * it and why), and doing something about it: setting its plan or a contract of
 * its own, giving or taking credits, waiving its usage or seats (and lifting
 * that), recording a payment that came in by hand. Each in a dialog that says
 * exactly what will happen, on a button naming it: all of it is on the org's
 * record, and most of it can only be corrected afterwards, not undone.
 */
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Icon,
  Input,
  Notice,
  Select,
  Tabs,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import { nameOf } from "../../../../access/spaces/contract.ts";
import {
  amountOf,
  type BillingState,
  dayShown,
  dollars,
  includes,
  money,
  seatsSaid,
  slug,
  startOfDay,
  type Terms,
  type Waiver,
} from "./numbers.ts";
import { type Call, type Org, useAct } from "./types.ts";

type Person = { person: string; name?: string; email?: string };
type Doing = "plan" | "grant" | "waive" | "pay";
type Props = { state: BillingState; org?: Org; call: Call; onChanged(): Promise<void> };

export function StaffPanel({ state, org, call, onChanged }: Props): ReactNode {
  const [doing, setDoing] = useState<Doing>();
  const [lifting, setLifting] = useState<"usage" | "seats">();
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    call<{ people: Person[] }>("org.people", {}).then((found) => setPeople(found.people), () => {});
  }, []);
  const who = (id?: string) => {
    if (!id) return "someone";
    const found = people.find((p) => p.person === id);
    return found?.name || found?.email || nameOf(id);
  };
  const plan = state.plan;
  const name = org?.name ?? "this org";
  const waived = plan?.waived;
  const close = () => {
    setDoing(undefined);
    setLifting(undefined);
  };
  const shared = { state, org: name, call, close, onChanged };
  return (
    <section className="billing-staff" aria-labelledby="billing-staff">
      <header className="billing-staff-head">
        <Badge tone="warning">
          <Icon name="shield" size={12} />
          Staff only
        </Badge>
        <span id="billing-staff">
          Setting {name}'s billing by hand. What you do here is on its record.
        </span>
      </header>
      <div className="billing-staff-now">
        <dl className="billing-facts">
          <div>
            <dt>Plan</dt>
            <dd>
              {plan ? plan.terms.title : "None started yet"}
              {plan && plan.name.toLowerCase() !== plan.terms.title.toLowerCase()
                ? <small>· {plan.name}</small>
                : null}
            </dd>
          </div>
          {plan
            ? (
              <div>
                <dt>Paid through</dt>
                <dd>
                  {plan.channel ?? "manual"}
                  {plan.status ? <small>· {plan.status}</small> : null}
                  {plan.customer ? <small>· {plan.customer}</small> : null}
                </dd>
              </div>
            )
            : null}
          {plan?.fixedSeats !== undefined
            ? (
              <div>
                <dt>Fixed seats</dt>
                <dd>{seatsSaid(plan.fixedSeats)}</dd>
              </div>
            )
            : null}
          <div>
            <dt>Balance</dt>
            <dd>{money(state.balance ?? 0)}</dd>
          </div>
        </dl>
        <WaiverLine
          what="usage"
          waiver={waived?.usage}
          who={who}
          onLift={() => setLifting("usage")}
        />
        <WaiverLine
          what="seats"
          waiver={waived?.seats}
          who={who}
          onLift={() => setLifting("seats")}
        />
      </div>
      <div className="billing-staff-actions">
        <Button icon="pencil" onClick={() => setDoing("plan")}>Set plan</Button>
        <Button icon="plus" onClick={() => setDoing("grant")}>Give or take credits</Button>
        <Button icon="pause" onClick={() => setDoing("waive")}>Waive</Button>
        <Button icon="note" onClick={() => setDoing("pay")}>Record a payment</Button>
      </div>
      <PlanDialog open={doing === "plan"} {...shared} />
      <GrantDialog open={doing === "grant"} {...shared} />
      <WaiveDialog open={doing === "waive"} people={people} {...shared} />
      <PayDialog open={doing === "pay"} {...shared} />
      <LiftDialog what={lifting} {...shared} />
    </section>
  );
}

/** A waiver in force: what, who and why, until when, and lifting it. */
function WaiverLine(
  { what, waiver, who, onLift }: {
    what: "usage" | "seats";
    waiver?: Waiver;
    who(id?: string): string;
    onLift(): void;
  },
): ReactNode {
  if (!waiver) return null;
  return (
    <div className="billing-waiver">
      <div>
        <b>{what === "usage" ? "Usage waived" : "Seats waived"}</b>
        <p>
          “{waiver.reason}”, by {who(waiver.by)}, since {dayShown(waiver.from)}
          {waiver.until ? `, until ${dayShown(waiver.until)}` : ", until lifted"}
          {waiver.people?.length ? `, for ${waiver.people.map((id) => who(id)).join(", ")}` : ""}
        </p>
      </div>
      <Button size="sm" onClick={onLift}>Lift</Button>
    </div>
  );
}

type Shared = {
  open: boolean;
  state: BillingState;
  org: string;
  call: Call;
  close(): void;
  onChanged(): Promise<void>;
};

/** A dialog's footer, its button naming what it does. */
const Footer = (
  { close, busy, ready, onGo, label, tone }: {
    close(): void;
    busy: boolean;
    ready: boolean;
    onGo(): void;
    label: string;
    tone?: "destructive";
  },
) => (
  <>
    <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
    <Button variant={tone ?? "primary"} loading={busy} disabled={!ready} onClick={onGo}>
      {label}
    </Button>
  </>
);

const termsLine = (terms: Terms) => includes(terms).join(" · ") || "No credits of its own";

function PlanDialog({ open, state, org, call, close, onChanged }: Shared): ReactNode {
  const plans = state.plans ?? {};
  const names = Object.keys(plans);
  const [kind, setKind] = useState<"listed" | "contract">("listed");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [monthly, setMonthly] = useState("");
  const [seats, setSeats] = useState("");
  const { busy, error, run, clear } = useAct();
  useEffect(() => {
    if (!open) return;
    setKind("listed");
    setName(names.find((n) => n !== state.plan?.name) ?? names[0] ?? "");
    setTitle("");
    setMonthly("");
    setSeats("");
    clear();
  }, [open]);
  const credits = amountOf(monthly);
  const fixed = seats.trim() ? Number(seats) : undefined;
  const seatsWrong = fixed !== undefined && (!Number.isInteger(fixed) || fixed < 0);
  const listed = kind === "listed" ? plans[name] : undefined;
  const ready = kind === "listed"
    ? !!listed
    : !!title.trim() && (!monthly.trim() || credits !== undefined) && !seatsWrong;
  const hadFixed = state.plan?.fixedSeats !== undefined;
  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    void run(async () => {
      await call(
        "billing.setPlan",
        kind === "listed" ? { name, ...(hadFixed ? { seats: null } : {}) } : {
          name: slug(title) || "contract",
          terms: {
            title: title.trim(),
            ...(credits ? { credits: { monthly: credits } } : {}),
          },
          ...(fixed !== undefined ? { seats: fixed } : hadFixed ? { seats: null } : {}),
        },
      );
      await onChanged();
      close();
    });
  };
  const to = kind === "listed" ? listed?.title : title.trim();
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Set plan"
      description={state.plan ? `${org} is on ${state.plan.terms.title} now.` : undefined}
      footer={
        <Footer
          close={close}
          busy={busy}
          ready={ready}
          onGo={() => go()}
          label={to ? `Move to ${to}` : "Move"}
        />
      }
    >
      <form className="billing-dialog" onSubmit={go}>
        <Tabs
          label="A plan, or a contract"
          value={kind}
          onChange={setKind}
          tabs={[{ value: "listed", label: "A plan" }, { value: "contract", label: "A contract" }]}
        />
        {kind === "listed"
          ? (
            <Field label="Plan" hint={listed ? termsLine(listed) : undefined}>
              {(control) => (
                <Select
                  {...control}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                >
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {plans[n].title}
                      {n === state.plan?.name ? " (now)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )
          : (
            <>
              <Field label="Name" hint="As the org's owners and admins will see it.">
                {(control) => (
                  <Input
                    {...control}
                    value={title}
                    maxLength={80}
                    placeholder="Acme contract"
                    onChange={(event) => setTitle(event.target.value)}
                  />
                )}
              </Field>
              <div className="billing-two">
                <Field
                  label="Credits a month"
                  error={monthly.trim() && credits === undefined
                    ? "That isn't an amount."
                    : undefined}
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      placeholder="0"
                      className="billing-money-input"
                      value={monthly}
                      onChange={(event) => setMonthly(event.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Fixed seats"
                  error={seatsWrong ? "A whole number." : undefined}
                  hint={seatsWrong ? undefined : "Empty: count its people."}
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="numeric"
                      placeholder="Its people"
                      value={seats}
                      onChange={(event) => setSeats(event.target.value)}
                    />
                  )}
                </Field>
              </div>
            </>
          )}
        <p className="billing-text">
          It takes effect now, and its period starts today. What {org}{" "}
          has stays until it lapses; the new plan's credits land next time it's checked.
          {hadFixed && (kind === "listed" || fixed === undefined)
            ? " Its seats go back to counting its people."
            : ""}
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function GrantDialog({ open, org, call, close, onChanged }: Shared): ReactNode {
  const [way, setWay] = useState<"give" | "take">("give");
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const { busy, error, run, clear } = useAct();
  useEffect(() => {
    if (!open) return;
    setWay("give");
    setTyped("");
    setReason("");
    setExpires("");
    clear();
  }, [open]);
  const amount = amountOf(typed);
  const ready = !!amount && !!reason.trim();
  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    void run(async () => {
      await call("billing.grant", {
        amount: way === "give" ? amount : -amount!,
        reason: reason.trim(),
        ...(way === "give" && expires ? { expires } : {}),
      });
      await onChanged();
      close();
    });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Give or take credits"
      footer={
        <Footer
          close={close}
          busy={busy}
          ready={ready}
          onGo={() => go()}
          tone={way === "take" ? "destructive" : undefined}
          label={amount
            ? `${way === "give" ? "Give" : "Take"} ${money(amount)}`
            : way === "give"
            ? "Give"
            : "Take"}
        />
      }
    >
      <form className="billing-dialog" onSubmit={go}>
        <Tabs
          label="Give or take"
          value={way}
          onChange={setWay}
          tabs={[{ value: "give", label: "Give" }, { value: "take", label: "Take away" }]}
        />
        <div className="billing-two">
          <Field
            label="Amount"
            error={typed.trim() && !amount ? "That isn't an amount." : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                autoFocus
                placeholder="0"
                className="billing-money-input"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            )}
          </Field>
          {way === "give"
            ? (
              <Field label="Lapses on" hint="Empty: they don't lapse.">
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={expires}
                    onChange={(event) => setExpires(event.target.value)}
                  />
                )}
              </Field>
            )
            : null}
        </div>
        <Field label="Why" hint={`${org}'s owners and admins see this in their history.`}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              placeholder="Welcome credits for the pilot"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <p className="billing-text">
          {way === "give"
            ? `${org} can use these right away. Any debt is covered first.`
            : `These come off ${org}'s balance now. If that takes it to nothing, its work stops.`}
          {" "}
          It stays in the history: to correct it, give or take again.
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function WaiveDialog(
  { open, org, call, close, onChanged, people }: Shared & { people: Person[] },
): ReactNode {
  const [what, setWhat] = useState<"usage" | "seats">("usage");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [whose, setWhose] = useState<string[]>([]);
  const { busy, error, run, clear } = useAct();
  useEffect(() => {
    if (!open) return;
    setWhat("usage");
    setReason("");
    setUntil("");
    setWhose([]);
    clear();
  }, [open]);
  const ready = !!reason.trim();
  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    void run(async () => {
      await call("billing.waive", {
        what,
        reason: reason.trim(),
        ...(until ? { until: startOfDay(until) } : {}),
        ...(what === "seats" && whose.length ? { people: whose } : {}),
      });
      await onChanged();
      close();
    });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Waive"
      footer={
        <Footer
          close={close}
          busy={busy}
          ready={ready}
          onGo={() => go()}
          label={what === "usage" ? "Waive usage" : "Waive seats"}
        />
      }
    >
      <form className="billing-dialog" onSubmit={go}>
        <Tabs
          label="What to waive"
          value={what}
          onChange={setWhat}
          tabs={[{ value: "usage", label: "Usage" }, { value: "seats", label: "Seats" }]}
        />
        <Field label="Why">
          {(control) => (
            <Input
              {...control}
              autoFocus
              value={reason}
              placeholder="Design partner"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <Field label="Ends on" hint="Empty: until you lift it.">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
            />
          )}
        </Field>
        {what === "seats" && people.length
          ? (
            <fieldset className="billing-people">
              <legend>Whose (none ticked: every seat)</legend>
              {people.map((p) => (
                <Checkbox
                  key={p.person}
                  label={p.name || p.email || nameOf(p.person)}
                  checked={whose.includes(p.person)}
                  onChange={(event) =>
                    setWhose(
                      event.target.checked
                        ? [...whose, p.person]
                        : whose.filter((id) => id !== p.person),
                    )}
                />
              ))}
            </fieldset>
          )
          : null}
        <p className="billing-text">
          {what === "usage"
            ? `${org}'s usage is still recorded but isn't charged, and when this ends none of it counts against its credits. Its owners and admins see that usage isn't charged, not why.`
            : `Those seats aren't paid for, from the next time its seats are counted.`}
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function LiftDialog(
  { what, org, call, close, onChanged, state }: Omit<Shared, "open"> & {
    what?: "usage" | "seats";
  },
): ReactNode {
  const { busy, error, run } = useAct();
  const go = () =>
    void run(async () => {
      await call("billing.waive", { what: what!, lift: true });
      await onChanged();
      close();
    });
  const noCredits = (state.balance ?? 0) <= 0;
  return (
    <Dialog
      open={!!what}
      onClose={close}
      size="sm"
      title={what === "usage" ? "Start charging usage again?" : "Stop waiving seats?"}
      footer={
        <Footer
          close={close}
          busy={busy}
          ready
          onGo={go}
          label="Lift the waiver"
        />
      }
    >
      <p className="billing-text">
        {what === "usage"
          ? `From now on, ${org}'s usage comes off its credits. What it used while waived doesn't count.${
            noCredits ? " It has no credits now, so its work stops." : ""
          }`
          : `${org}'s seats are all paid for again, from the next time they're counted.`}
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

const PURPOSES = [
  { value: "credits", label: "Credits" },
  { value: "seats", label: "Seats" },
  { value: "contract", label: "Contract" },
  { value: "refund", label: "Refund" },
];

function PayDialog({ open, org, call, close, onChanged }: Shared): ReactNode {
  const [ref, setRef] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("usd");
  const [purpose, setPurpose] = useState("credits");
  const [credits, setCredits] = useState("");
  const [rate, setRate] = useState("");
  const [fee, setFee] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run, clear } = useAct();
  useEffect(() => {
    if (!open) return;
    setRef("");
    setAmount("");
    setCurrency("usd");
    setPurpose("credits");
    setCredits("");
    setRate("");
    setFee("");
    setNote("");
    clear();
  }, [open]);
  const paid = amountOf(amount);
  const bought = amountOf(credits);
  const rated = amountOf(rate);
  const kept = amountOf(fee);
  const usd = currency.trim().toLowerCase() === "usd";
  const codeWrong = !/^[a-zA-Z]{3}$/.test(currency.trim());
  const bad = (text: string, parsed: number | undefined) => !!text.trim() && parsed === undefined;
  const refund = purpose === "refund";
  const ready = !!ref.trim() && !!paid && !codeWrong && !bad(credits, bought) &&
    !bad(rate, rated) &&
    !bad(fee, kept) && (usd || !!rated);
  const go = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    void run(async () => {
      await call("billing.pay", {
        ref: ref.trim(),
        amount: refund ? -paid! : paid!,
        currency: currency.trim().toLowerCase(),
        purpose,
        ...(bought ? { credits: refund ? -bought : bought } : {}),
        ...(rated && !usd ? { rate: rated } : {}),
        ...(kept ? { fee: kept } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await onChanged();
      close();
    });
  };
  const adds = bought
    ? refund ? `takes ${money(bought)} of credits back` : `adds ${money(bought)} of credits`
    : "changes no credits";
  return (
    <Dialog
      open={open}
      onClose={close}
      title={refund ? "Record a refund" : "Record a payment"}
      description={`Money that came in by hand, for ${org}.`}
      footer={
        <Footer
          close={close}
          busy={busy}
          ready={ready}
          onGo={() => go()}
          label={refund ? "Record the refund" : "Record the payment"}
        />
      }
    >
      <form className="billing-dialog" onSubmit={go}>
        <div className="billing-two">
          <Field label="Reference" hint="An invoice or transfer number. Once each.">
            {(control) => (
              <Input
                {...control}
                autoFocus
                value={ref}
                placeholder="INV-1042"
                spellCheck={false}
                onChange={(event) => setRef(event.target.value)}
              />
            )}
          </Field>
          <Field label="What for">
            {(control) => (
              <Select
                {...control}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              >
                {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            )}
          </Field>
          <Field
            label={refund ? "Amount refunded" : "Amount paid"}
            error={bad(amount, paid) ? "That isn't an amount." : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Currency"
            error={currency.trim() && codeWrong ? "Three letters: usd, brl…" : undefined}
          >
            {(control) => (
              <Input
                {...control}
                value={currency}
                maxLength={3}
                spellCheck={false}
                onChange={(event) => setCurrency(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={refund ? "Credits to take back" : "Credits it buys"}
            error={bad(credits, bought) ? "That isn't an amount." : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                placeholder="0"
                className="billing-money-input"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="What the channel kept"
            error={bad(fee, kept) ? "That isn't an amount." : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                placeholder="0"
                value={fee}
                onChange={(event) => setFee(event.target.value)}
              />
            )}
          </Field>
          {usd ? null : (
            <Field
              label="USD per unit"
              error={bad(rate, rated) ? "That isn't an amount." : undefined}
              hint="Needed, as it isn't in USD."
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  placeholder="0.18"
                  value={rate}
                  onChange={(event) => setRate(event.target.value)}
                />
              )}
            </Field>
          )}
        </div>
        <Field label="Note" hint="Its owners and admins see this.">
          {(control) => (
            <Input
              {...control}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        <p className="billing-text">
          {paid
            ? `This keeps ${dollarsIn(paid, currency, usd)} for ${org} and ${adds}.`
            : `This keeps the payment for ${org}.`} It can't be edited after: a refund corrects it.
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

const dollarsIn = (amount: number, currency: string, usd: boolean) =>
  usd ? dollars(amount) : `${amount} ${currency.trim().toUpperCase()}`;
