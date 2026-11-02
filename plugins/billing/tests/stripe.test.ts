/**
 * Stripe: a signature that isn't Stripe's goes nowhere; each event lands as the
 * same facts staff would enter, once however often it's sent; another product's
 * events on the same account are left alone; and paying starts on Stripe's own
 * page, for who may, with what the webhook will need.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models from "../../models/mod.ts";
import { access } from "../../access/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { credits, stripe, stripeWebhook, usage } from "../mod.ts";
import { encode } from "../stripe/shared/api.ts";
import { verified } from "../stripe/shared/events.ts";
import { sellerFor, type StripeSettings } from "../stripe/shared/settings.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

const sign = async (secret: string, payload: string, at = Math.floor(Date.now() / 1000)) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${at}.${payload}`),
  );
  const hex = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${at},v1=${hex}`;
};

const asked: { url: string; body: string; headers: Record<string, string> }[] = [];
const fakeFetch = ((url: string, init: RequestInit) => {
  asked.push({
    url,
    body: String(init.body ?? ""),
    headers: init.headers as Record<string, string>,
  });
  const body = url.includes("/v1/charges/")
    ? { id: "ch_9", amount: 2500, currency: "usd", metadata: { org: "org-1", credits: "25" } }
    : url.includes("/v1/subscriptions/")
    ? { items: { data: [{ id: "si_1", quantity: 1 }] } }
    : { url: "https://checkout.stripe.test/pay" };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const settings: StripeSettings = {
  url: "https://app.test",
  seller: "main",
  fetch: fakeFetch,
  sellers: {
    main: {
      key: "rk_test_main",
      webhookSecret: "whsec_main",
      currency: "usd",
      credits: "prod_credits",
      prices: { team: "price_team" },
    },
    br: {
      key: "rk_test_br",
      webhookSecret: "whsec_br",
      currency: "brl",
      rate: 0.2,
      countries: ["BR"],
      credits: "prod_credits_br",
      prices: {},
    },
  },
};

async function setup(
  fn: (
    rt: Awaited<ReturnType<typeof createRuntime>>,
    send: (event: unknown, seller?: string, secret?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  asked.length = 0;
  const rt = await createRuntime({
    store: await sqliteStore({ path: tempFile() }),
    plugins: [
      models,
      chat,
      ...access,
      usage,
      credits,
      stripe,
      definePlugin({
        name: "app",
        resources: {
          org: { id: "org-1", name: "Org", kind: "personal" },
          stripe: settings,
          shared: { thread: {}, message: {} },
          billing: {
            plans: {
              free: { title: "Free", credits: { once: 2 } },
              team: {
                title: "Team",
                seat: { price: 20, currency: "usd" },
                credits: { perSeat: 10 },
              },
            },
          },
        },
      }),
    ],
  });
  await rt.call("org.join", { person: "ana", role: "owner" });
  await rt.call("org.join", { person: "bob" });
  const hook = stripeWebhook({
    settings,
    start: "free",
    runtime: (org) => Promise.resolve(org === "org-1" ? rt : undefined),
  });
  const send = async (event: unknown, seller = "main", secret = "whsec_main") => {
    const payload = JSON.stringify(event);
    return await hook(
      new Request("https://app.test/__stripe/main", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": await sign(secret, payload) },
      }),
      seller,
    );
  };
  try {
    await fn(rt, send);
  } finally {
    await rt.close();
  }
}

const stateOf = (rt: Awaited<ReturnType<typeof createRuntime>>) =>
  rt.call<{
    balance: number;
    seats: number;
    plan: { name: string; status?: string; customer?: string; subscription?: string };
    buckets: { kind: string; left: number }[];
    payments: { ref: string; amount: number; purpose: string; credits?: number }[];
    pay: { manage: boolean; topUps: number[]; plans: { name: string }[] } | null;
  }>("billing.state", {}, { actor: ana });

const paidCredits = {
  id: "evt_1",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_1",
      mode: "payment",
      payment_status: "paid",
      customer: "cus_1",
      currency: "usd",
      amount_subtotal: 2500,
      amount_total: 2500,
      metadata: { org: "org-1", purpose: "credits", credits: "25" },
    },
  },
};

test("a signature that isn't Stripe's, or is old, goes nowhere", async () => {
  const body = "{}";
  assert(await verified("s", body, await sign("s", body)));
  assert(!await verified("other", body, await sign("s", body)));
  assert(!await verified("s", "{ }", await sign("s", body)));
  assert(!await verified("s", body, null));
  assert(!await verified("s", body, await sign("s", body, Math.floor(Date.now() / 1000) - 3600)));
  await setup(async (rt, send) => {
    assertEquals((await send(paidCredits, "main", "whsec_wrong")).status, 400);
    assertEquals((await send(paidCredits, "gone")).status, 404);
    assertEquals((await stateOf(rt)).balance, 2);
  });
});

test("credits bought land once, however often it's sent, with the customer kept", async () => {
  await setup(async (rt, send) => {
    for (let i = 0; i < 3; i++) assertEquals((await send(paidCredits)).status, 200);
    // The same session again in another event, as the second of an async payment.
    await send({ ...paidCredits, id: "evt_2", type: "checkout.session.async_payment_succeeded" });
    const state = await stateOf(rt);
    assertEquals([state.balance, state.plan.customer], [27, "cus_1"]);
    assertEquals(state.payments.length, 1);
    assertEquals(state.pay?.manage, true);
  });
});

test("a checkout that completes unpaid gives nothing until its money comes", async () => {
  await setup(async (rt, send) => {
    const unpaid = {
      ...paidCredits,
      data: { object: { ...paidCredits.data.object, payment_status: "unpaid" } },
    };
    assertEquals((await (await send(unpaid)).json()).ignored, "checkout.session.completed");
    assertEquals((await stateOf(rt)).balance, 2);
    await send({ ...paidCredits, id: "evt_2", type: "checkout.session.async_payment_succeeded" });
    assertEquals((await stateOf(rt)).balance, 27);
  });
});

test("other products on the account, and orgs that are gone, are received and left alone", async () => {
  await setup(async (rt, send) => {
    const theirs = {
      ...paidCredits,
      data: { object: { ...paidCredits.data.object, metadata: {} } },
    };
    assertEquals((await send(theirs)).status, 200);
    const gone = {
      ...paidCredits,
      data: { object: { ...paidCredits.data.object, metadata: { org: "org-gone", credits: "9" } } },
    };
    assertEquals((await send(gone)).status, 200);
    assertEquals((await stateOf(rt)).balance, 2);
  });
});

const NOW = Math.floor(Date.now() / 1000);
const DAYS = 86400;

const paidInvoice = (
  id: string,
  sub = "sub_1",
  start = NOW - 3600,
  end = NOW + 30 * DAYS,
  seats = 2,
  reason = "subscription_create",
) => ({
  id: `evt_${id}`,
  type: "invoice.paid",
  data: {
    object: {
      id,
      currency: "usd",
      subtotal: seats * 2000,
      amount_paid: seats * 2000,
      billing_reason: reason,
      lines: { data: [{ quantity: seats, period: { start, end } }] },
      parent: {
        subscription_details: { subscription: sub, metadata: { org: "org-1", plan: "team" } },
      },
    },
  },
});

const subscribed = (sub = "sub_1", id = "evt_s1") => ({
  id,
  type: "checkout.session.completed",
  created: 1000,
  data: {
    object: {
      id: `cs_${sub}`,
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_2",
      subscription: sub,
      metadata: { org: "org-1", plan: "team" },
    },
  },
});

const ended = (sub = "sub_1", id = "evt_e1") => ({
  id,
  type: "customer.subscription.deleted",
  created: 2000,
  data: { object: { id: sub, status: "canceled", metadata: { org: "org-1" } } },
});

const failed = (sub: string, id: string, created: number) => ({
  id,
  type: "invoice.payment_failed",
  created,
  data: {
    object: {
      parent: { subscription_details: { subscription: sub, metadata: { org: "org-1" } } },
    },
  },
});

test("a subscription: on its plan; its credits come with the money, for what was paid", async () => {
  await setup(async (rt, send) => {
    await stateOf(rt);
    await send(subscribed());
    let state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.status, state.plan.subscription], [
      "team",
      "active",
      "sub_1",
    ]);
    assertEquals(state.buckets.find((b) => b.kind === "plan"), undefined, "nothing paid yet");

    await send(paidInvoice("in_1"));
    state = await stateOf(rt);
    assertEquals(state.payments.map((p) => [p.ref, p.amount, p.purpose]), [["in_1", 40, "seats"]]);
    assertEquals(state.buckets.find((b) => b.kind === "plan")?.left, 20, "two seats paid for");
    // Sent again, nothing more.
    await send(paidInvoice("in_1"));
    assertEquals((await stateOf(rt)).buckets.find((b) => b.kind === "plan")?.left, 20);
    // A seat added midway pays its part: its credits come with the next period.
    await send(paidInvoice("in_p", "sub_1", NOW - 3600, NOW + 30 * DAYS, 3, "subscription_update"));
    assertEquals((await stateOf(rt)).buckets.find((b) => b.kind === "plan")?.left, 20);
    // The next period: as many as it charged for, whoever has joined since.
    await send(
      paidInvoice("in_2", "sub_1", NOW + 30 * DAYS, NOW + 60 * DAYS, 3, "subscription_cycle"),
    );
    assertEquals(
      (await stateOf(rt)).buckets.filter((b) => b.kind === "plan").map((b) => b.left).sort(),
      [20, 30],
    );

    await send(failed("sub_1", "evt_f1", 1500));
    state = await stateOf(rt);
    assertEquals(state.plan.status, "past_due");
    assertEquals(
      state.buckets.filter((b) => b.kind === "plan").length,
      2,
      "a failed payment grants nothing",
    );

    await send(ended());
    state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.status, state.plan.subscription], [
      "free",
      "canceled",
      undefined,
    ]);
  });
});

test("news comes out of order: an ended subscription stays ended; old news changes nothing", async () => {
  await setup(async (rt, send) => {
    await stateOf(rt);
    // Ended, and only then the checkout that began it arrives.
    await send(ended("sub_1"));
    await send(subscribed("sub_1", "evt_late"));
    let state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.subscription], ["free", undefined]);

    // A new one; the old one's end, and its failed payments, don't touch it.
    await send(subscribed("sub_2", "evt_new"));
    await send(failed("sub_1", "evt_f", 3000));
    await send(ended("sub_1", "evt_e2"));
    state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.status, state.plan.subscription], [
      "team",
      "active",
      "sub_2",
    ]);

    // Its own, in the wrong order: the older says nothing.
    await send(failed("sub_2", "evt_f2", 5000));
    await send({
      id: "evt_u",
      type: "customer.subscription.updated",
      created: 4000,
      data: { object: { id: "sub_2", status: "active", metadata: { org: "org-1" } } },
    });
    assertEquals((await stateOf(rt)).plan.status, "past_due");
  });
});

test("a plan the app no longer has isn't tried forever; another seller's event isn't ours", async () => {
  await setup(async (rt, send) => {
    await stateOf(rt);
    const gone = subscribed();
    gone.data.object.metadata = { org: "org-1", plan: "gone" };
    const quiet = console.error;
    console.error = () => {};
    assertEquals((await send(gone)).status, 200);
    console.error = quiet;
    const theirs = {
      ...paidCredits,
      data: {
        object: {
          ...paidCredits.data.object,
          metadata: { org: "org-1", credits: "25", seller: "other" },
        },
      },
    };
    assertEquals((await send(theirs)).status, 200);
    assertEquals((await stateOf(rt)).balance, 2);
  });
});

test("a dispute and a refund on one charge take back once; a dispute won gives it back", async () => {
  await setup(async (rt, send) => {
    await send(paidCredits);
    await send({
      id: "evt_d1",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_9", amount: 2500 } },
    });
    assertEquals((await stateOf(rt)).balance, 2);
    await send({
      id: "evt_r1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_9",
          amount: 2500,
          amount_refunded: 2500,
          disputed: true,
          currency: "usd",
          metadata: { org: "org-1", credits: "25" },
        },
        previous_attributes: { amount_refunded: 0 },
      },
    });
    assertEquals((await stateOf(rt)).balance, 2);
    await send({
      id: "evt_d2",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_1", charge: "ch_9", amount: 2500, status: "won" } },
    });
    assertEquals((await stateOf(rt)).balance, 27);
  });
});

test("a refund takes back what it paid for, in proportion; a dispute takes it all", async () => {
  await setup(async (rt, send) => {
    await send(paidCredits);
    const charge = {
      id: "ch_9",
      amount: 2500,
      currency: "usd",
      metadata: { org: "org-1", credits: "25" },
    };
    await send({
      id: "evt_r1",
      type: "charge.refunded",
      data: {
        object: { ...charge, amount_refunded: 1000 },
        previous_attributes: { amount_refunded: 0 },
      },
    });
    assertEquals((await stateOf(rt)).balance, 17);
    await send({
      id: "evt_r2",
      type: "charge.refunded",
      data: {
        object: { ...charge, amount_refunded: 1500 },
        previous_attributes: { amount_refunded: 1000 },
      },
    });
    assertEquals((await stateOf(rt)).balance, 12);
    await send({
      id: "evt_d1",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_9", amount: 1000 } },
    });
    assertEquals((await stateOf(rt)).balance, 2);
    assert(asked.some((a) => a.url.endsWith("/v1/charges/ch_9")));
  });
});

test("buying credits: on Stripe's page, for who may, with what the webhook needs", async () => {
  await setup(async (rt) => {
    await assertRejects(() => rt.call("billing.checkout", { credits: 1 }, { actor: ana }));
    await assertRejects(() => rt.call("billing.checkout", { credits: 99999 }, { actor: ana }));
    await assertRejects(() => rt.call("billing.checkout", { credits: 25 }, { actor: bob }));
    await assertRejects(() =>
      rt.call("billing.checkout", { credits: 25 }, { actor: { ...ana, key: "k" } as Actor })
    );
    const { url } = await rt.call<{ url: string }>("billing.checkout", { credits: 25 }, {
      actor: ana,
    });
    assertEquals(url, "https://checkout.stripe.test/pay");
    const last = asked.at(-1)!;
    assert(last.url.endsWith("/v1/checkout/sessions"));
    assertEquals(last.headers.authorization, "Bearer rk_test_main");
    assertEquals(last.headers["stripe-version"], "2026-10-28.endive");
    const sent = new URLSearchParams(last.body);
    assertEquals(sent.get("mode"), "payment");
    assertEquals(sent.get("line_items[0][price_data][unit_amount]"), "2500");
    assertEquals(sent.get("line_items[0][price_data][product]"), "prod_credits");
    assertEquals(sent.get("metadata[org]"), "org-1");
    assertEquals(sent.get("metadata[credits]"), "25");
    assertEquals(sent.get("payment_intent_data[metadata][credits]"), "25");
    assert(sent.get("success_url")!.startsWith("https://app.test/org?tab=billing"));
    assert(!last.body.includes("payment_method_types"));
  });
});

test("subscribing: a seat each, its plan's price; only a plan with one; only once", async () => {
  await setup(async (rt, send) => {
    await rt.call("billing.checkout", { plan: "team" }, { actor: ana });
    const sent = new URLSearchParams(asked.at(-1)!.body);
    assertEquals(sent.get("mode"), "subscription");
    assertEquals(sent.get("line_items[0][price]"), "price_team");
    assertEquals(sent.get("line_items[0][quantity]"), "2");
    assertEquals(sent.get("subscription_data[metadata][org]"), "org-1");
    await assertRejects(() => rt.call("billing.checkout", { plan: "free" }, { actor: ana }));
    await assertRejects(
      () => rt.call("billing.portal", {}, { actor: ana }),
      Error,
      "nothing to manage",
    );
    await send(subscribed());
    await assertRejects(
      () => rt.call("billing.checkout", { plan: "team" }, { actor: ana }),
      Error,
      "already has a subscription",
    );
    assertEquals(await rt.call("billing.portal", {}, { actor: ana }), {
      url: "https://checkout.stripe.test/pay",
    });
    // Its seats follow the org's people.
    assertEquals(await rt.call("stripe.seats", {}), { seats: 2 });
    assert(asked.at(-1)!.url.endsWith("/v1/subscription_items/si_1"));
  });
});

test("who sells: who it pays already, else by country, else the default; BRL at the seller's rate", async () => {
  assertEquals(sellerFor(settings, undefined)?.[0], "main");
  assertEquals(sellerFor(settings, undefined, "US")?.[0], "main");
  assertEquals(sellerFor(settings, undefined, "br")?.[0], "br");
  assertEquals(sellerFor(settings, "main", "BR")?.[0], "main");
  await setup(async (rt) => {
    await rt.call("billing.checkout", { credits: 10, country: "BR" }, { actor: ana });
    const last = asked.at(-1)!;
    assertEquals(last.headers.authorization, "Bearer rk_test_br");
    const sent = new URLSearchParams(last.body);
    assertEquals(sent.get("line_items[0][price_data][currency]"), "brl");
    assertEquals(sent.get("line_items[0][price_data][unit_amount]"), "5000");
  });
});

test("parameters go as Stripe reads them", () => {
  assertEquals(encode({ a: { b: [{ c: 1 }, { c: 2 }] }, d: "x", e: undefined, f: true }), [
    ["a[b][0][c]", "1"],
    ["a[b][1][c]", "2"],
    ["d", "x"],
    ["f", "true"],
  ]);
});
