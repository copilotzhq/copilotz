/**
 * Billing as the web says it: what `billing.state` answers, in words and
 * numbers people read. Money to the cent, so a balance can be trusted; a day
 * as the calendar has it, wherever you are (the backend's days are UTC);
 * credits by what they are and in the order they're spent; what a plan
 * includes and what it comes to for the org's seats; why the org is stopped
 * or running low; how far along the month's budget is; an amount as typed; and
 * whether what was just paid has landed. Only prices: never a cost or a fee.
 */

const MINUS = "−";
const DAY = 86_400_000;

/** A pile of credits, as the walk leaves it: what it was, what's left, when it lapses. */
export type Bucket = { id: string; kind: string; amount: number; left: number; expires?: string };

/** A credit in the org's history. */
export type CreditRow = {
  _id: string;
  kind: string;
  amount: number;
  at: string;
  expires?: string;
  note?: string;
};

/** Money that came in. */
export type PaymentRow = {
  _id: string;
  channel: string;
  ref: string;
  amount: number;
  currency: string;
  purpose: string;
  credits?: number;
  note?: string;
  fee?: number;
  rate?: number;
  at: string;
};

export type Seat = { price: number; currency: string };
export type CreditTerms = { once?: number; monthly?: number; perSeat?: number };
export type Terms = { title: string; seat?: Seat; credits?: CreditTerms; prices?: string };

/** A waiver: why, by whom, until when; for seats, whose. */
export type Waiver = {
  from: string;
  reason: string;
  until?: string;
  by?: string;
  people?: string[];
};

export type Plan = {
  name: string;
  terms: Terms;
  since: string;
  channel?: string;
  status?: string;
  customer?: string;
  subscription?: string;
  fixedSeats?: number;
  waived?: { usage?: Waiver; seats?: Waiver };
};

/** A plan the org can move to by itself. */
export type Offer = { name: string; title: string; seat: Seat; credits?: CreditTerms };

export type Pay = {
  topUps: number[];
  min: number;
  max: number;
  plans: Offer[];
  manage: boolean;
};

export type Month = { start: string; end: string; spent: number; limit?: number };

/** What `billing.state` answers. People who don't run the org get only the first few. */
export type BillingState = {
  on: boolean;
  runs: boolean;
  staff: boolean;
  ok?: boolean;
  why?: "credits" | "budget";
  message?: string;
  low?: boolean;
  plan?: Plan | null;
  seats?: number;
  /** Those a seat is charged for: all but those waived. */
  billedSeats?: number;
  /** What it's running low on. */
  lowOn?: "credits" | "budget";
  period?: { start: string; end: string };
  balance?: number;
  buckets?: Bucket[];
  debt?: number;
  waived?: boolean;
  month?: Month;
  history?: CreditRow[];
  payments?: PaymentRow[];
  pay?: Pay | null;
  plans?: Record<string, Terms>;
};

/** Dollars to the cent: "$1,234.50", "$0.00"; "<$0.01" for crumbs; a minus sign below zero. */
export function money(n: number): string {
  if (n < 0) return `${MINUS}${money(-n)}`;
  if (n > 0 && n < 0.005) return "<$0.01";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Dollars, cents only when there are some: "$25", "$12.50", "$1,000". */
export function dollars(n: number): string {
  if (n < 0) return `${MINUS}${dollars(-n)}`;
  const cents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/** An amount in its currency: "$25", "R$ 100.50"; a code it doesn't know stands as it is. */
export function inCurrency(n: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "USD") return dollars(n);
  const cents = Math.round(Math.abs(n) * 100) % 100 !== 0;
  try {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}

/** A day as the calendar has it ("Dec 1"; its year when it isn't this one), wherever you are. */
export function dayShown(day: string, now = Date.now()): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  const year = date.getUTCFullYear() !== new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  });
}

/** The day before: a period's last, since the backend's `end` is the first day after it. */
export const dayBefore = (day: string): string =>
  new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

/** A period's dates, its last day included: "Nov 1 to Nov 30". */
export const periodShown = (period: { start: string; end: string }, now = Date.now()): string =>
  `${dayShown(period.start, now)} to ${dayShown(dayBefore(period.end), now)}`;

/** When something happened, where you are: "Nov 1", with its year when it isn't this one. */
export function whenShown(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const year = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  });
}

const KINDS: Record<string, string> = {
  trial: "Trial credits",
  plan: "Plan credits",
  gift: "Gift",
  referral: "Referral",
  purchase: "Purchased",
  waived: "Usage given back",
  adjustment: "Adjustment",
};

/** What a credit is, in words. */
export const kindSaid = (kind: string): string =>
  KINDS[kind] ?? kind[0].toUpperCase() + kind.slice(1);

const PURPOSES: Record<string, string> = {
  seats: "Plan",
  credits: "Credits",
  contract: "Contract",
  refund: "Refund",
};

/** What a payment was for, in words. */
export const purposeSaid = (purpose: string): string => PURPOSES[purpose] ?? purpose;

/** A credit's expiry, for a row: when it lapses, or that it doesn't. */
export const lapseSaid = (expires: string | undefined, now = Date.now()): string =>
  expires ? `Lapses ${dayShown(expires, now)}` : "Doesn't lapse";

/**
 * Credits as they read: those of one kind that lapse alike are one pile, and
 * the order they'll be spent in stays.
 */
export function pilesOf(buckets: Bucket[]): Bucket[] {
  const piles = new Map<string, Bucket>();
  for (const bucket of buckets) {
    const key = `${bucket.kind}:${bucket.expires ?? ""}`;
    const pile = piles.get(key);
    if (pile) {
      pile.left += bucket.left;
      pile.amount += bucket.amount;
    } else piles.set(key, { ...bucket });
  }
  return [...piles.values()];
}

/** Newest first, however it came. */
export const newestFirst = <T extends { at: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => b.at.localeCompare(a.at));

/** What a plan's terms give, in sentences' pieces, and for this many seats. */
export function includes(terms: Pick<Terms, "credits">, seats?: number): string[] {
  const c = terms.credits ?? {};
  const said: string[] = [];
  if (c.once) said.push(`${dollars(c.once)} of credits to start`);
  if (c.monthly) said.push(`${dollars(c.monthly)} of credits each month`);
  if (c.perSeat) {
    const all = seats && seats > 1 ? ` (${dollars(c.perSeat * seats)} for ${seats} seats)` : "";
    said.push(`${dollars(c.perSeat)} of credits a seat each month${all}`);
  }
  return said;
}

/** "1 seat", "3 seats". */
export const seatsSaid = (n: number): string =>
  `${n.toLocaleString("en-US")} seat${n === 1 ? "" : "s"}`;

/** What a plan comes to, per seat and for the org's: what's asked before they go. */
export function priceFor(seat: Seat, seats: number | undefined): { each: string; total: string } {
  const count = Math.max(seats ?? 1, 1);
  return {
    each: `${inCurrency(seat.price, seat.currency)} a seat, each month`,
    total: `${inCurrency(seat.price * count, seat.currency)} a month for ${seatsSaid(count)}`,
  };
}

/** What it says the org is running low on. */
export const lowOn = (s: BillingState): "credits" | "budget" | undefined =>
  s.low ? s.lowOn ?? "credits" : undefined;

/** How the month stands against its limit: the meter's fill, and fine, near or at it. */
export function budgetStand(
  s: Pick<BillingState, "month" | "ok" | "why" | "low" | "buckets" | "balance" | "waived">,
): {
  limit?: number;
  spent: number;
  left?: number;
  share: number;
  tone: "none" | "fine" | "near" | "at";
} {
  const spent = s.month?.spent ?? 0;
  const limit = s.month?.limit;
  if (limit === undefined) return { spent, share: 0, tone: "none" };
  const at = (s.ok === false && s.why === "budget") || spent >= limit;
  const share = limit > 0 ? Math.min(spent / limit, 1) : 1;
  const near = share >= 0.8 || lowOn({ on: true, runs: true, staff: false, ...s }) === "budget";
  return {
    limit,
    spent,
    left: Math.max(limit - spent, 0),
    share: at ? 1 : share,
    tone: at ? "at" : near ? "near" : "fine",
  };
}

/** An amount as typed: "$1,000.50" is 1000.5. None for what isn't one. */
export function amountOf(typed: string): number | undefined {
  const plain = typed.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(plain)) return undefined;
  return Math.round(Number(plain) * 100) / 100;
}

/** Whether a typed top-up can be bought, and what to say if not. */
export function topUpOf(
  typed: string,
  limits: Pick<Pay, "min" | "max">,
): { amount: number } | { error: string } {
  const range = `Between ${dollars(limits.min)} and ${dollars(limits.max)}.`;
  const amount = amountOf(typed);
  if (amount === undefined || amount < limits.min || amount > limits.max) return { error: range };
  return { amount };
}

/** What the org's balance comes to after adding this (any debt is paid first). */
export const balanceAfter = (balance: number, adding: number): number => balance + adding;

/** What's kept on leaving for a payment page, to tell on coming back what's new. */
export type Before = { payments: string[]; plan?: string; subscription?: string };

export const beforeOf = (s: BillingState): Before => ({
  payments: (s.payments ?? []).map((p) => p._id),
  ...(s.plan?.name ? { plan: s.plan.name } : {}),
  ...(s.plan?.subscription ? { subscription: s.plan.subscription } : {}),
});

/** How long back a payment counts as this one, when nothing was kept on leaving (another tab). */
const RECENT = 60 * 60_000;

/**
 * What landed, if it has, from a payment just made: words to thank them with,
 * or none while it hasn't. Only what the state shows counts, never that they
 * came back.
 */
export function landed(
  s: BillingState,
  paid: "credits" | "plan",
  before: Before | undefined,
  now = Date.now(),
): string | undefined {
  if (paid === "plan") {
    const plan = s.plan;
    if (!plan?.subscription) return undefined;
    if (before && plan.subscription === before.subscription && plan.name === before.plan) {
      return undefined;
    }
    return `You're on the ${plan.terms.title} plan.`;
  }
  const fresh = (s.payments ?? []).filter((p) =>
    p.purpose === "credits" && p.amount > 0 &&
    (before ? !before.payments.includes(p._id) : now - Date.parse(p.at) < RECENT)
  );
  if (!fresh.length) return undefined;
  const bought = fresh.reduce((sum, p) => sum + (p.credits ?? 0), 0);
  return bought > 0 ? `${money(bought)} of credits added.` : "Your credits are in.";
}

/** What `?paid=` says was just paid, if anything we know. */
export const paidIn = (search: string): "credits" | "plan" | undefined => {
  const paid = new URLSearchParams(search).get("paid");
  return paid === "credits" || paid === "plan" ? paid : undefined;
};

/** The address without `?paid=`, so reading it again doesn't confirm it again. */
export function withoutPaid(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("paid");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Who to ask when nothing can be bought: the app's team, by the name the page's title ends with. */
export function teamOf(title: string): string {
  const app = title.split(" · ").pop()?.trim();
  return app ? `the ${app} team` : "the team";
}

/** A contract's id, from its title: "Acme & Co" is `acme-co`. */
export const slug = (title: string): string =>
  title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** A date field's day, as the moment it starts (UTC): when a waiver or a code ends. */
export const startOfDay = (day: string): string => `${day}T00:00:00.000Z`;

/** The stop or low notice above the composer, in words (`billing.notice`'s answer). */
export type Notice = {
  tone: "stop" | "low";
  why: "credits" | "budget";
  left?: number;
  runs: boolean;
};

/** Which low notice this is, so dismissing one says nothing of the other. */
export const noticeKey = (n: Notice): string => `${n.tone}:${n.why}`;

/** What the note above the composer says. */
export function noticeSaid(n: Notice, personal = false): { title: string; more?: string } {
  const org = personal ? "You're" : "This org is";
  const has = personal ? "You've" : "This org has";
  if (n.tone === "stop") {
    return n.why === "budget"
      ? {
        title: `${has} reached the month's budget`,
        ...(n.runs ? {} : { more: "Its owners and admins can raise it." }),
      }
      : {
        title: `${org} out of credits`,
        ...(n.runs ? {} : { more: "Its owners and admins can add more." }),
      };
  }
  return n.why === "budget"
    ? { title: `${money(n.left ?? 0)} left of this month's budget` }
    : { title: `${money(n.left ?? 0)} of credits left` };
}
