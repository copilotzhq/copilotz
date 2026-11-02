/**
 * Billing on the web: money to the cent, days as the calendar has them, credits
 * in the order they're spent, what a plan comes to before anyone pays, why the
 * org is stopped or running low, an amount as typed, that a payment only counts
 * once the state shows it, and what's drawn for the org's standing, for those
 * who run it and those who don't: only ever prices, never a fee.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { failedOwn } from "../../agents/chat/views/web/message.tsx";
import { codeStatus, newCodeOf } from "../../interfaces/web/shared/codes.ts";
import { paidBy } from "../usage/views/web/org.tsx";
import { sizesOf } from "../../compute/cloud/views/web/cloud.ts";
import { NewCloud } from "../../compute/cloud/views/web/new.tsx";
import { BudgetCard } from "../credits/views/web/budget.tsx";
import { History } from "../credits/views/web/history.tsx";
import {
  amountOf,
  beforeOf,
  type BillingState,
  budgetStand,
  dayBefore,
  dayShown,
  dollars,
  includes,
  inCurrency,
  kindSaid,
  landed,
  lapseSaid,
  lowOn,
  money,
  newestFirst,
  noticeSaid,
  paidIn,
  periodShown,
  pilesOf,
  priceFor,
  slug,
  teamOf,
  topUpOf,
  withoutPaid,
} from "../credits/views/web/numbers.ts";
import { Balance, ForMembers } from "../credits/views/web/org.tsx";
import { PlanCard, PlanOffers } from "../credits/views/web/plan.tsx";

const MINUS = "−";
const NOW = Date.parse("2026-11-15T12:00:00Z");
const call = () => Promise.resolve({} as never);

const text = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();

/** Where an org that runs on credits stands, for who runs it. */
const standing = (more: Partial<BillingState> = {}): BillingState => ({
  on: true,
  runs: true,
  staff: false,
  ok: true,
  low: false,
  plan: { name: "free", terms: { title: "Free", credits: { once: 5 } }, since: "2026-11-01" },
  balance: 5,
  buckets: [{ id: "trial", kind: "trial", amount: 5, left: 5 }],
  debt: 0,
  waived: false,
  month: { start: "2026-11-01", end: "2026-12-01", spent: 0 },
  history: [],
  payments: [],
  pay: {
    topUps: [10, 25],
    min: 5,
    max: 2000,
    plans: [{
      name: "team",
      title: "Team",
      seat: { price: 20, currency: "usd" },
      credits: { perSeat: 10 },
    }],
    manage: false,
  },
  ...more,
});

test("money to the cent, cents only when there are some, and crumbs never read as none", () => {
  assertEquals(
    [money(0), money(5), money(1234.5), money(0.004), money(-3.2)],
    ["$0.00", "$5.00", "$1,234.50", "<$0.01", `${MINUS}$3.20`],
  );
  assertEquals([dollars(25), dollars(12.5), dollars(1000)], ["$25", "$12.50", "$1,000"]);
  assertEquals(inCurrency(100, "usd"), "$100");
  assertEquals(inCurrency(100.5, "brl"), "R$100.50");
  assertEquals(inCurrency(-40, "USD"), `${MINUS}$40`);
});

test("days as the calendar has them, wherever you are: the backend's are UTC", () => {
  assertEquals(dayShown("2026-12-01", NOW), "Dec 1");
  assertEquals(dayShown("2027-01-31", NOW), "Jan 31, 2027");
  assertEquals(dayBefore("2026-12-01"), "2026-11-30");
  // A period's `end` is the first day after it.
  assertEquals(periodShown({ start: "2026-11-01", end: "2026-12-01" }, NOW), "Nov 1 to Nov 30");
  assertEquals(lapseSaid("2026-12-01", NOW), "Lapses Dec 1");
  assertEquals(lapseSaid(undefined, NOW), "Doesn't lapse");
});

test("credits by what they are, in the order they'll be spent, alike ones as one pile", () => {
  assertEquals(kindSaid("purchase"), "Purchased");
  assertEquals(kindSaid("somethingnew"), "Somethingnew");
  const piles = pilesOf([
    { id: "a", kind: "plan", amount: 10, left: 4, expires: "2026-12-01" },
    { id: "b", kind: "gift", amount: 5, left: 5 },
    { id: "c", kind: "gift", amount: 3, left: 3 },
    { id: "d", kind: "purchase", amount: 50, left: 50 },
  ]);
  assertEquals(piles.map((p) => [p.kind, p.left, p.amount]), [
    ["plan", 4, 10],
    ["gift", 8, 8],
    ["purchase", 50, 50],
  ]);
  const rows = newestFirst([{ at: "2026-11-01" }, { at: "2026-11-03" }, { at: "2026-11-02" }]);
  assertEquals(rows.map((r) => r.at), ["2026-11-03", "2026-11-02", "2026-11-01"]);
});

test("what a plan includes, and what it comes to for the org's seats, before they go", () => {
  assertEquals(includes({ credits: { once: 5 } }), ["$5 of credits to start"]);
  assertEquals(includes({ credits: { monthly: 100, perSeat: 10 } }, 3), [
    "$100 of credits each month",
    "$10 of credits a seat each month ($30 for 3 seats)",
  ]);
  assertEquals(includes({}), []);
  assertEquals(priceFor({ price: 20, currency: "usd" }, 3), {
    each: "$20 a seat, each month",
    total: "$60 a month for 3 seats",
  });
  // There's always a seat to pay for, as a checkout charges.
  assertEquals(priceFor({ price: 20, currency: "usd" }, 0).total, "$20 a month for 1 seat");
});

test("why it's low: whichever is nearer its end", () => {
  assertEquals(lowOn(standing()), undefined);
  assertEquals(lowOn(standing({ low: true, lowOn: "credits" })), "credits");
  assertEquals(lowOn(standing({ low: true, lowOn: "budget" })), "budget");
});

test("the budget: none, fine, near it and at it, in numbers that never overflow", () => {
  const at = (spent: number, limit?: number, more: Partial<BillingState> = {}) =>
    budgetStand(standing({
      month: { start: "2026-11-01", end: "2026-12-01", spent, ...(limit ? { limit } : {}) },
      ...more,
    }));
  assertEquals(at(3).tone, "none");
  assertEquals(at(3, 20).tone, "fine");
  assertEquals(at(17, 20).tone, "near");
  assertEquals(at(20, 20).tone, "at");
  assertEquals(at(30, 20).share, 1);
  assertEquals(at(30, 20).left, 0);
  assertEquals(at(3, 20, { ok: false, why: "budget" }).tone, "at");
  assertEquals(at(0, 0, { month: { start: "", end: "", spent: 0, limit: 0 } }).tone, "at");
});

test("an amount as typed, and whether it can be bought", () => {
  assertEquals(
    [amountOf("25"), amountOf("$1,000.50"), amountOf(" 7.5 "), amountOf(".5")],
    [25, 1000.5, 7.5, 0.5],
  );
  assertEquals([amountOf(""), amountOf("abc"), amountOf("-5"), amountOf("1.2.3")], [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  const limits = { min: 5, max: 2000 };
  assertEquals(topUpOf("25", limits), { amount: 25 });
  assertEquals(topUpOf("3", limits), { error: "Between $5 and $2,000." });
  assertEquals(topUpOf("9000", limits), { error: "Between $5 and $2,000." });
  assertEquals(topUpOf("nope", limits), { error: "Between $5 and $2,000." });
});

test("a payment counts only once the state shows it, however soon they came back", () => {
  assertEquals(paidIn("?tab=billing&paid=credits"), "credits");
  assertEquals(paidIn("?tab=billing&paid=plan"), "plan");
  assertEquals(paidIn("?tab=billing&paid=nonsense"), undefined);
  assertEquals(paidIn("?tab=billing"), undefined);
  assertEquals(withoutPaid("?tab=billing&paid=credits"), "?tab=billing");
  assertEquals(withoutPaid("?paid=plan"), "");

  const old = {
    _id: "stripe:old",
    channel: "stripe",
    ref: "old",
    amount: 10,
    currency: "usd",
    purpose: "credits",
    credits: 10,
    at: "2026-11-15T11:00:00Z",
  };
  const before = standing({ payments: [old] });
  const kept = beforeOf(before);
  assertEquals(landed(before, "credits", kept, NOW), undefined);
  const after = standing({
    payments: [{ ...old, _id: "stripe:new", credits: 25, at: "2026-11-15T12:00:00Z" }, old],
  });
  assertEquals(landed(after, "credits", kept, NOW), "$25.00 of credits added.");
  // A refund isn't a purchase.
  assertEquals(
    landed(
      standing({ payments: [{ ...old, _id: "r", amount: -10, credits: -10 }, old] }),
      "credits",
      kept,
      NOW,
    ),
    undefined,
  );
  // Nothing kept (another tab): a recent one counts, an older one doesn't.
  assertEquals(landed(after, "credits", undefined, NOW), "$25.00 of credits added.");
  assertEquals(
    landed(
      standing({ payments: [{ ...old, at: "2026-11-01T00:00:00Z" }] }),
      "credits",
      undefined,
      NOW,
    ),
    undefined,
  );

  const plan = { name: "team", terms: { title: "Team" }, since: "2026-11-01" };
  assertEquals(landed(standing(), "plan", beforeOf(standing()), NOW), undefined);
  const moved = standing({ plan: { ...plan, subscription: "sub_1" } });
  assertEquals(landed(moved, "plan", beforeOf(standing()), NOW), "You're on the Team plan.");
  assertEquals(landed(moved, "plan", beforeOf(moved), NOW), undefined);
});

test("who to ask when nothing can be bought; a contract's id from its name", () => {
  assertEquals(teamOf("Acme: Billing · Compass"), "the Compass team");
  assertEquals(teamOf("Compass"), "the Compass team");
  assertEquals(teamOf(""), "the team");
  assertEquals(slug("Acme & Co, 2026"), "acme-co-2026");
});

test("the note above where you type, in plain words", () => {
  const said = (n: Parameters<typeof noticeSaid>[0], personal?: boolean) => noticeSaid(n, personal);
  assertEquals(said({ tone: "stop", why: "credits", runs: true }), {
    title: "This org is out of credits",
  });
  assertEquals(said({ tone: "stop", why: "credits", runs: false }), {
    title: "This org is out of credits",
    more: "Its owners and admins can add more.",
  });
  assertEquals(said({ tone: "stop", why: "budget", runs: false }), {
    title: "This org has reached the month's budget",
    more: "Its owners and admins can raise it.",
  });
  assertEquals(said({ tone: "low", why: "credits", left: 0.9, runs: true }), {
    title: "$0.90 of credits left",
  });
  assertEquals(said({ tone: "low", why: "budget", left: 3, runs: true }), {
    title: "$3.00 left of this month's budget",
  });
  assertEquals(said({ tone: "stop", why: "credits", runs: true }, true), {
    title: "You're out of credits",
  });
});

test("the balance: out of credits and debt, plainly, with the way forward right there", () => {
  const out = text(
    <Balance
      state={standing({
        ok: false,
        why: "credits",
        balance: -3.2,
        debt: 3.2,
        buckets: [],
      })}
      personal={false}
      team="the Compass team"
      quiet={false}
    />,
  );
  assertStringIncludes(out, "This org is out of credits");
  assertStringIncludes(out, "Nothing is deleted");
  assertStringIncludes(out, "Add credits");
  assertStringIncludes(out, `${MINUS}$3.20`);
  assertStringIncludes(out, "The next credits cover that first");
});

test("the balance: nothing to buy says who to ask, with no dead buttons", () => {
  const out = text(
    <Balance
      state={standing({ ok: false, why: "credits", balance: 0, buckets: [], pay: null })}
      personal={false}
      team="the Compass team"
      quiet={false}
    />,
  );
  assertStringIncludes(out, "Credits come from the Compass team");
  assert(!out.includes("Add credits"), out);
});

test("the balance: while a payment is confirmed it doesn't say they're out", () => {
  const out = text(
    <Balance
      state={standing({ ok: false, why: "credits", balance: 0, buckets: [] })}
      personal={false}
      team="the Compass team"
      quiet
    />,
  );
  assert(!out.includes("out of credits"), out);
});

test("the balance: waived says so, with no numbers", () => {
  const out = text(
    <Balance
      state={standing({ waived: true, balance: -12, debt: 12 })}
      personal={false}
      team="the Compass team"
      quiet={false}
    />,
  );
  assertStringIncludes(out, "Usage isn't charged");
  assert(!out.includes("$"), out);
});

test("the balance: at the budget, what stopped and how to change it", () => {
  const out = text(
    <Balance
      state={standing({
        ok: false,
        why: "budget",
        month: { start: "2026-11-01", end: "2026-12-01", spent: 20, limit: 20 },
      })}
      personal
      team="the Compass team"
      quiet={false}
    />,
  );
  assertStringIncludes(out, "You've reached this month's $20.00 budget");
  assertStringIncludes(out, "Change budget");
  assertStringIncludes(out, "It resets Dec 1");
});

test("the plan: past due says so and how to fix it; a live subscription offers no checkout", () => {
  const plan = {
    name: "team",
    terms: { title: "Team", seat: { price: 20, currency: "usd" }, credits: { perSeat: 10 } },
    since: "2026-11-01",
    status: "past_due",
    customer: "cus_1",
    subscription: "sub_1",
  };
  const state = standing({
    plan,
    seats: 3,
    period: { start: "2026-11-02", end: "2026-12-02" },
    pay: { ...standing().pay!, manage: true },
  });
  const card = text(<PlanCard state={state} team="the Compass team" call={call} />);
  assertStringIncludes(card, "The last payment didn't go through");
  assertStringIncludes(card, "Fix payment");
  assertStringIncludes(card, "3 seats");
  assertStringIncludes(card, "$30 for 3 seats");
  assert(!card.includes("renews"), card);
  assertEquals(renderToStaticMarkup(<PlanOffers state={state} call={call} />), "");
});

test("moving to a plan shows the total for the org's seats before they go", () => {
  const out = text(<PlanOffers state={standing({ seats: 3 })} call={call} />);
  assertStringIncludes(out, "Team");
  assertStringIncludes(out, "$20 a seat, each month");
  assertStringIncludes(out, "$60 a month for 3 seats");
  assertStringIncludes(out, "Move to Team");
});

test("on a contract, nothing offers a checkout: what it would charge isn't the contract's seats", () => {
  const plan = { name: "acme", terms: { title: "Acme" }, since: "2026-11-01", fixedSeats: 12 };
  assertEquals(
    renderToStaticMarkup(<PlanOffers state={standing({ plan, seats: 12 })} call={call} />),
    "",
  );
});

test("the budget's card: a meter, its month's end, and a clear state at the limit", () => {
  const month = { start: "2026-11-01", end: "2026-12-01", spent: 17, limit: 20 };
  const near = text(
    <BudgetCard state={standing({ month })} call={call} onChanged={() => Promise.resolve()} />,
  );
  assertStringIncludes(near, "$17.00 of $20.00");
  assertStringIncludes(near, "Near the limit");
  assertStringIncludes(near, "Resets Dec 1");
  const at = text(
    <BudgetCard
      state={standing({ month: { ...month, spent: 20 }, ok: false, why: "budget" })}
      call={call}
      onChanged={() => Promise.resolve()}
    />,
  );
  assertStringIncludes(at, "Limit reached");
  const none = text(
    <BudgetCard state={standing()} call={call} onChanged={() => Promise.resolve()} />,
  );
  assertStringIncludes(none, "Set a limit");
});

test("history: newest first, and only staff see what the channel kept", () => {
  const history = [
    { _id: "a", kind: "trial", amount: 5, at: "2026-11-01T00:00:00Z", note: "Free" },
    { _id: "b", kind: "gift", amount: 10, at: "2026-11-03T00:00:00Z", note: "Thanks" },
    { _id: "c", kind: "adjustment", amount: -2, at: "2026-11-02T00:00:00Z", note: "Fixed" },
  ];
  const out = text(<History state={standing({ history })} />);
  assert(
    out.indexOf("Thanks") < out.indexOf("Fixed") && out.indexOf("Fixed") < out.indexOf("Free plan"),
    out,
  );
  assertStringIncludes(out, "+$10.00");
  assertStringIncludes(out, `${MINUS}$2.00`);
  assertStringIncludes(text(<History state={standing()} />), "No credits yet");
});

test("someone who doesn't run it sees whether work can go on and who can help, no numbers", () => {
  const org = { id: "o", name: "Acme", kind: "team" };
  const out = text(
    <ForMembers
      state={{ on: true, runs: false, staff: false, ok: false, why: "credits" }}
      org={org}
    />,
  );
  assertStringIncludes(out, "Acme is out of credits");
  assertStringIncludes(out, "Its owners and admins can add more");
  assert(!out.includes("$"), out);
  const fine = text(
    <ForMembers state={{ on: true, runs: false, staff: false, ok: true }} org={org} />,
  );
  assertStringIncludes(fine, "look after its billing");
});

test("a stop message isn't the agent failing; one that says so is", () => {
  assertEquals(failedOwn({ from: "maya", text: "maya failed: the model said no" }), true);
  assertEquals(failedOwn({ from: "maya", text: "" }), true);
  assertEquals(failedOwn({ from: "maya", text: "This org is out of credits." }), false);
});

test("a call someone else pays for says so, rather than $0", () => {
  assertEquals(paidBy({ paid: "own-key" })?.label, "Your key");
  assertEquals(paidBy({ paid: "subscription" })?.label, "Plan");
  assertEquals(paidBy({}), undefined);
  assertEquals(paidBy(undefined), undefined);
});

test("a computer refused for what the org can spend says so plainly, and who can help", () => {
  const sizes = sizesOf({
    sizes: [{ id: "s", vcpu: 2, memory: 4, perHour: 0.1 }],
    create: false,
    why: "credits",
  });
  const out = text(<NewCloud space="s" sizes={sizes} call={call} />);
  assertStringIncludes(out, "This org is out of credits");
  assertStringIncludes(out, "Your computers and files are safe");
  assertStringIncludes(out, "Go to Billing");
});

test("gift codes in the console: where each stands, and what's asked for", () => {
  const code = {
    id: "x",
    short: "abc",
    amount: 25,
    by: "sam",
    at: "2026-11-01T00:00:00Z",
  };
  const now = "2026-11-15T00:00:00.000Z";
  assertEquals(codeStatus(code, now), "waiting");
  assertEquals(codeStatus({ ...code, org: "o", claimed: now }, now), "claimed");
  assertEquals(codeStatus({ ...code, revoked: now }, now), "revoked");
  assertEquals(codeStatus({ ...code, until: "2026-11-02T00:00:00.000Z" }, now), "expired");
  assertEquals(newCodeOf({ amount: "$1,000", expires: "", until: "", note: " " }), {
    amount: 1000,
  });
  assertEquals(
    newCodeOf({ amount: "25", expires: "2027-01-01", until: "2026-12-01", note: "Hi" }),
    { amount: 25, expires: "2027-01-01", until: "2026-12-01T23:59:59.999Z", note: "Hi" },
  );
  assert("error" in newCodeOf({ amount: "nope", expires: "", until: "", note: "" }));
  assert("error" in newCodeOf({ amount: "0", expires: "", until: "", note: "" }));
});
