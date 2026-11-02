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
          org: { id: "org-1", name: "Org", kind: "team" },
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

test("a subscription: on its plan, its seats' credits come, unpaid it stops, ended it goes back", async () => {
  await setup(async (rt, send) => {
    await send({
      id: "evt_s1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_2",
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_2",
          subscription: "sub_1",
          metadata: { org: "org-1", plan: "team" },
        },
      },
    });
    let state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.status, state.plan.subscription], [
      "team",
      "active",
      "sub_1",
    ]);
    assertEquals(state.buckets.find((b) => b.kind === "plan")?.left, 20, "two seats, $10 each");

    await send({
      id: "evt_s2",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          currency: "usd",
          subtotal: 4000,
          amount_paid: 4000,
          parent: {
            subscription_details: { subscription: "sub_1", metadata: { org: "org-1" } },
          },
        },
      },
    });
    state = await stateOf(rt);
    assertEquals(state.payments.map((p) => [p.ref, p.amount, p.purpose]), [["in_1", 40, "seats"]]);
    assertEquals(state.balance, 20, "a seat's fee buys no credits of its own");

    await send({
      id: "evt_s3",
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_1", metadata: { org: "org-1" } } },
        },
      },
    });
    assertEquals((await stateOf(rt)).plan.status, "past_due");

    await send({
      id: "evt_s4",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", status: "canceled", metadata: { org: "org-1" } } },
    });
    state = await stateOf(rt);
    assertEquals([state.plan.name, state.plan.status, state.plan.subscription], [
      "free",
      "canceled",
      undefined,
    ]);
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
    await send({
      id: "evt_s1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_2",
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_2",
          subscription: "sub_1",
          metadata: { org: "org-1", plan: "team" },
        },
      },
    });
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
