/**
 * Credits: an org starts with its trial, spends it, and is stopped in plain
 * words; gifts, budgets, waivers, codes, plans and payments change that, each
 * by who may; what's left is known without the ledger, and stays right across
 * executors and restarts; and with limits off, nothing starts.
 */
import { assert, assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Store,
} from "../../../runtime/mod.ts";
import { postgresPool, postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { credits, usage, type UsageRecord } from "../mod.ts";
import { env, tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const staff: Actor = { kind: "person", id: "sam", staff: true };

/** A model that costs $1 a call at a margin of 0; `calls`: those it took. */
let calls = 0;
let retried = 0;
const script: LlmAdapter = {
  async *generate() {
    calls++;
    yield { type: "text", text: "done" };
    yield { type: "usage", input: 1_000_000, output: 0 };
  },
};

const app = (settings: Record<string, unknown> = {}, resources: Record<string, unknown> = {}) =>
  definePlugin({
    name: "app",
    adapters: { llm: { script } },
    resources: {
      provider: {
        script: { adapter: "script" },
        plan: { adapter: "script", tags: { paid: "subscription" } },
      },
      cost: { "script/*": { input: 1 }, "plan/*": { input: 0 } },
      agents: {
        lead: { instructions: "Hi.", model: "script/m", default: true },
        chain: { instructions: "Hi.", model: ["script/m", "plan/m"] },
      },
      shared: { thread: {}, message: {} },
      billing: {
        plans: {
          free: { title: "Free", credits: { once: 2 } },
          team: { title: "Team", seat: { price: 20, currency: "usd" }, credits: { perSeat: 10 } },
        },
        ...settings,
      },
      ...resources,
    },
    processors: {
      retries: { on: "processor.retried", run: () => void retried++ },
    },
    actions: {
      "test.use": defineAction({
        input: { type: "object" },
        run: (ctx, input) => ctx.call("usage.record", input),
      }),
      "test.all": defineAction({
        input: { type: "object", properties: { collection: { type: "string" } } },
        run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
      }),
      "test.generate": defineAction({
        input: { type: "object", properties: { purpose: { type: "string" } } },
        run: (ctx, input) =>
          ctx.call("llm.generate", {
            model: "script/m",
            messages: [{ role: "user", content: "hi" }],
            ...(input.purpose ? { tags: { purpose: input.purpose } } : {}),
          }),
      }),
    },
  });

type Rt = Awaited<ReturnType<typeof createRuntime>>;

async function started(
  store: Store,
  settings: Record<string, unknown> = {},
  more: { executors?: number; plugins?: Plugin[]; resources?: Record<string, unknown> } = {},
) {
  const rt = await createRuntime({
    store,
    executors: more.executors ?? 1,
    plugins: [
      models,
      chat,
      ...access,
      usage,
      credits,
      app(settings, more.resources),
      ...(more.plugins ?? []),
    ],
  });
  await rt.call("org.join", { person: "ana", role: "owner" });
  await rt.call("org.join", { person: "bob" });
  return rt;
}

async function setup(
  fn: (rt: Rt) => Promise<void>,
  settings: Record<string, unknown> = {},
  more: Parameters<typeof started>[2] = {},
) {
  calls = 0;
  retried = 0;
  const rt = await started(await sqliteStore({ path: tempFile() }), settings, more);
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

/** A turn: its last message. */
async function ask(rt: Rt, agent = "lead") {
  const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
  await rt.call("member.set", { space, member: { kind: "agent", id: agent }, role: "editor" }, {
    actor: ana,
  }).catch(() => {});
  const { thread } = await rt.call<{ thread: string }>("chat.send", {
    in: space,
    text: agent === "lead" ? "hello" : `@${agent} hello`,
  }, { actor: ana });
  await rt.idle();
  return (await rt.query<Message[]>("message.history", { thread }, { actor: ana })).at(-1)!;
}

const stateOf = <T = Record<string, unknown>>(rt: Rt, actor = ana) =>
  rt.call<T & { ok: boolean; why?: string; balance: number }>("billing.state", {}, { actor });

test("a new org gets its trial, spends it, and is stopped in plain words, once, not failing", async () => {
  await setup(async (rt) => {
    assertEquals((await ask(rt)).text, "done");
    assertEquals((await ask(rt)).text, "done");
    assertEquals(calls, 2);
    const last = await ask(rt);
    assertEquals(calls, 2, "no call was made");
    assertEquals(
      last.text,
      "This org is out of credits. Its owners and admins can add more in [Billing](/org?tab=billing).",
    );
    assertEquals((await rt.call<unknown[]>("test.all", { collection: "usage" })).length, 2);
    assertEquals(retried, 0, "saying no isn't tried again");
    const state = await stateOf(rt);
    assertEquals([state.ok, state.why, state.balance], [false, "credits", 0]);
  });
});

test("usage from before an org's billing began doesn't count", async () => {
  await setup(async (rt) => {
    await rt.call("test.use", {
      meter: "llm",
      subject: "script/m",
      quantities: { input: 50_000_000 },
      at: "2026-01-01T00:00:00.000Z",
    });
    assertEquals((await ask(rt)).text, "done");
    assertEquals((await stateOf(rt)).balance, 1);
  });
});

test("the app's own upkeep isn't stopped, and is charged; a plan a person pays for hands over", async () => {
  await setup(async (rt) => {
    await ask(rt);
    await ask(rt);
    await assertRejects(() => rt.call("test.generate", {}), Error, "out of credits");
    await rt.call("test.generate", { purpose: "history" });
    assertEquals(calls, 3);
    assertEquals((await stateOf(rt)).balance, -1);
    // Out of credits, an agent with a person's plan next in its list goes on with it.
    assertEquals((await ask(rt, "chain")).text, "done");
    assertEquals(calls, 4);
  });
});

test("a gift gets it going again at once; only staff give, in person", async () => {
  await setup(async (rt) => {
    await ask(rt);
    await ask(rt);
    assert((await ask(rt)).text?.includes("out of credits"));
    const grant = { amount: 1, reason: "welcome" };
    await assertRejects(() => rt.call("billing.grant", grant, { actor: ana }), Error, "staff");
    await assertRejects(() =>
      rt.call("billing.grant", grant, { actor: { ...staff, key: "k" } as Actor })
    );
    await rt.call("billing.grant", grant, { actor: staff });
    assertEquals((await ask(rt)).text, "done");
    const [gift] = (await rt.call<{ kind: string; note: string; by: string }[]>("test.all", {
      collection: "credit",
    })).filter((c) => c.kind === "gift");
    assertEquals([gift.note, gift.by], ["welcome", "sam"]);
  });
});

test("the budget stops it first when it's lower; who runs the org changes it, others can't", async () => {
  await setup(async (rt) => {
    await stateOf(rt);
    await rt.call("billing.grant", { amount: 100, reason: "x" }, { actor: staff });
    await rt.call("billing.budget", { usd: 1 }, { actor: ana });
    assertEquals((await ask(rt)).text, "done");
    assertEquals(
      (await ask(rt)).text,
      "This org has reached its $1 budget for the month. Its owners and admins can raise it in [Billing](/org?tab=billing).",
    );
    assertEquals((await stateOf(rt)).why, "budget");
    await assertRejects(() => rt.call("billing.budget", { usd: 50 }, { actor: bob }));
    await rt.call("billing.budget", { usd: 50 }, { actor: ana });
    assertEquals((await ask(rt)).text, "done");
    await rt.call("billing.budget", { usd: null }, { actor: ana });
    assertEquals((await stateOf<{ month: { limit?: number } }>(rt)).month.limit, undefined);
  }, { budget: 50 });
});

test("a waived org isn't stopped by credits, still is by its budget, and owes nothing after", async () => {
  await setup(async (rt) => {
    await rt.call("billing.waive", { what: "usage", reason: "internal" }, { actor: staff });
    await assertRejects(() =>
      rt.call("billing.waive", { what: "usage", reason: "x" }, { actor: ana })
    );
    for (let i = 0; i < 4; i++) assertEquals((await ask(rt)).text, "done");
    // Its use is recorded all the same.
    assertEquals(
      (await rt.call<UsageRecord[]>("test.all", { collection: "usage" })).length,
      4,
    );
    assert((await ask(rt)).text?.includes("budget"), "the budget still holds");
    await rt.call("billing.budget", { usd: null }, { actor: ana });
    await rt.call("billing.waive", { what: "usage", lift: true }, { actor: staff });
    const state = await stateOf<{ waived: boolean; history: { kind: string; amount: number }[] }>(
      rt,
    );
    assertEquals(state.waived, false);
    // The trial is untouched: what it let through was given back.
    assertAlmostEquals(state.balance, 2);
    assertEquals(state.history.find((c) => c.kind === "waived")?.amount, 4);
  }, { budget: 4 });
});

test("people see whether work can go on; balances are for those who run the org", async () => {
  await setup(async (rt) => {
    const bobs = await stateOf(rt, bob);
    assertEquals(bobs, { on: true, runs: false, staff: false, ok: true } as never);
    const anas = await stateOf<{ runs: boolean; plan: { name: string }; plans?: unknown }>(rt);
    assertEquals([anas.runs, anas.plan.name, anas.balance, anas.plans], [
      true,
      "free",
      2,
      undefined,
    ]);
    assert((await stateOf<{ plans?: unknown }>(rt, staff)).plans, "staff see the plans to set");
    for (const action of ["billing.check", "billing.spent", "billing.apply", "billing.settle"]) {
      await assertRejects(
        () => rt.call(action, action === "billing.spent" ? { price: 1 } : {}, { actor: ana }),
        Error,
      );
    }
  });
});

test("running low is said to who can act on it; being out, to everyone", async () => {
  await setup(async (rt) => {
    assertEquals(await rt.call("billing.notice", {}, { actor: ana }), null);
    // $2 of credits, $1.70 of it spent.
    await rt.call("test.use", {
      meter: "llm",
      subject: "script/m",
      quantities: { input: 1_700_000 },
    });
    const low = await rt.call<{ tone: string; why: string; left: number }>(
      "billing.notice",
      {},
      { actor: ana },
    );
    assertEquals([low.tone, low.why], ["low", "credits"]);
    assertAlmostEquals(low.left, 0.3);
    assertEquals(await rt.call("billing.notice", {}, { actor: bob }), null);
    await rt.call("test.use", {
      meter: "llm",
      subject: "script/m",
      quantities: { input: 1_000_000 },
    });
    const out = await rt.call<{ tone: string; why: string; text: string }>(
      "billing.notice",
      {},
      { actor: bob },
    );
    assertEquals([out.tone, out.why], ["stop", "credits"]);
  });
});

test("seats: credits per seat each period, once however often it's checked, guests apart", async () => {
  await setup(async (rt) => {
    await rt.call("org.join", { person: "gus", role: "guest" });
    await rt.call("billing.setPlan", { name: "team" }, { actor: staff });
    await assertRejects(() => rt.call("billing.setPlan", { name: "team" }, { actor: ana }));
    await assertRejects(() => rt.call("billing.setPlan", { name: "gone" }, { actor: staff }));
    for (let i = 0; i < 3; i++) await stateOf(rt);
    const state = await stateOf<{
      seats: number;
      plan: { terms: { title: string } };
      buckets: { kind: string; left: number; expires?: string }[];
    }>(rt);
    assertEquals(state.seats, 2);
    assertEquals(state.plan.terms.title, "Team");
    const plan = state.buckets.find((b) => b.kind === "plan")!;
    assertEquals(plan.left, 20);
    assert(plan.expires, "a period's credits lapse");
  });
});

test("a contract is a record: its own terms, seats and price list", async () => {
  await setup(
    async (rt) => {
      await rt.call("billing.setPlan", {
        name: "acme",
        terms: { title: "Acme", credits: { monthly: 100 }, prices: "acme" },
        seats: 40,
      }, { actor: staff });
      const state = await stateOf<{ seats: number; balance: number }>(rt);
      assertEquals([state.seats, state.balance], [40, 100]);
      await rt.call("test.use", {
        meter: "llm",
        subject: "script/m",
        quantities: { input: 1_000_000 },
      });
      const [use] = await rt.call<UsageRecord[]>("test.all", { collection: "usage" });
      // A margin of 0.5 on this list: twice its cost.
      assertAlmostEquals(use.price!, 2);
      assertAlmostEquals((await stateOf(rt)).balance, 98);
    },
    {},
    { resources: { priceLists: { acme: { "*": { margin: 0.5 } } } } },
  );
});

test("a payment lands once, however often it's told; a refund takes its credits back", async () => {
  await setup(async (rt) => {
    await stateOf(rt);
    const payment = {
      channel: "stripe",
      seller: "compass",
      ref: "cs_1",
      amount: 25,
      currency: "usd",
      fee: 1.03,
      purpose: "credits",
      credits: 25,
    };
    for (let i = 0; i < 3; i++) {
      await rt.call("billing.apply", { payment }, { id: "stripe:evt_1" });
    }
    // Told again under another id, it's still the one payment.
    await rt.call("billing.apply", { payment }, { id: "stripe:evt_2" });
    assertEquals((await stateOf(rt)).balance, 27);
    assertEquals((await rt.call<unknown[]>("test.all", { collection: "payment" })).length, 1);
    await rt.call("billing.apply", {
      payment: { ...payment, ref: "re_1", amount: -25, purpose: "refund", credits: -25 },
    }, { id: "stripe:evt_3" });
    assertEquals((await stateOf(rt)).balance, 2);
    // By hand, the same; only staff.
    const hand = { ref: "inv-7", amount: 500, currency: "BRL", purpose: "contract", credits: 90 };
    await assertRejects(() => rt.call("billing.pay", hand, { actor: ana }));
    await rt.call("billing.pay", hand, { actor: staff });
    assertEquals((await stateOf(rt)).balance, 92);
  });
});

test("a gift code: claimed through the directory, once; only who runs the org redeems it", async () => {
  const claims: string[] = [];
  const directory = {
    claimCode: (code: string) => {
      if (code !== "GOOD") throw Object.assign(new Error("That code isn't valid."), { code: "x" });
      claims.push(code);
      return Promise.resolve({ id: "abc", amount: 7, note: "launch" });
    },
  };
  await setup(
    async (rt) => {
      await stateOf(rt);
      await assertRejects(() => rt.call("billing.redeem", { code: "GOOD" }, { actor: bob }));
      await assertRejects(
        () => rt.call("billing.redeem", { code: "BAD" }, { actor: ana }),
        Error,
        "isn't valid",
      );
      assertEquals(await rt.call("billing.redeem", { code: "GOOD" }, { actor: ana }), {
        amount: 7,
      });
      // A failed grant is retried: the same code, the same credit.
      await rt.call("billing.redeem", { code: "GOOD" }, { actor: ana });
      assertEquals((await stateOf(rt)).balance, 9);
      // The code is in no event.
      const kept = await rt.call<{ _id: string }[]>("test.all", { collection: "credit" });
      assert(kept.some((c) => c._id === "gift:abc"));
    },
    {},
    { resources: { directory } },
  );
});

test("two executors share one number: neither misses what the other spent", async () => {
  await setup(
    async (rt) => {
      await rt.call("billing.grant", { amount: 10, reason: "x" }, { actor: staff });
      await stateOf(rt);
      await Promise.all(
        Array.from(
          { length: 8 },
          () =>
            rt.call("test.use", {
              meter: "llm",
              subject: "script/m",
              quantities: { input: 1_000_000 },
            }),
        ),
      );
      const [room] = await rt.call<{ credits: number }[]>("test.all", {
        collection: "billingRoom",
      });
      assertAlmostEquals(room.credits, 4);
      assertAlmostEquals((await stateOf(rt)).balance, 4);
    },
    {},
    { executors: 2 },
  );
});

test("a restart loses nothing: the number comes back from what's kept", async () => {
  const path = tempFile();
  const first = await started(await sqliteStore({ path }));
  await ask(first);
  await ask(first);
  await first.close();
  const second = await started(await sqliteStore({ path }));
  try {
    assert((await ask(second)).text?.includes("out of credits"));
    assertEquals(
      await second.call("test.all", { collection: "billingRoom" }).then((r) => {
        return (r as unknown[]).length;
      }),
      1,
    );
  } finally {
    await second.close();
  }
});

test("a read can't write: it says yes without a number, and what the number says with one", async () => {
  await setup(async (rt) => {
    assertEquals(await rt.call("billing.may", {}), { ok: true });
    await ask(rt);
    await ask(rt);
    await rt.call("billing.check", {});
    assertEquals((await rt.call<{ ok: boolean }>("billing.may", {})).ok, false);
  });
});

test("with limits off, nothing starts, nobody's stopped, and only staff see anything", async () => {
  await setup(async (rt) => {
    for (let i = 0; i < 4; i++) assertEquals((await ask(rt)).text, "done");
    assertEquals((await rt.call<unknown[]>("test.all", { collection: "credit" })).length, 0);
    assertEquals((await rt.call<unknown[]>("test.all", { collection: "billingPlan" })).length, 0);
    assertEquals((await rt.call<unknown[]>("test.all", { collection: "billingRoom" })).length, 0);
    assertEquals(await rt.call("billing.notice", {}, { actor: ana }), null);
    assertEquals(await stateOf(rt), { on: false, runs: true, staff: false } as never);
    // Staff can prepare an org before limits go on, and its use from then on is given back.
    await rt.call("billing.waive", { what: "usage", reason: "internal" }, { actor: staff });
    const seen = await stateOf<{ on: boolean; waived: boolean }>(rt, staff);
    assertEquals([seen.on, seen.waived], [false, true]);
  }, { enforce: false });
});

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");

test({
  name: "on PostgreSQL too: a plan, its waivers lifted, and what's left",
  ignore: !POSTGRES,
  fn: async () => {
    const pool = await postgresPool({ url: POSTGRES! });
    const schema = `credits_${crypto.randomUUID().slice(0, 8)}`;
    calls = 0;
    const rt = await started(await postgresStore({ pool, schema, tenant: "org" }), {}, {
      executors: 2,
    });
    try {
      assertEquals((await ask(rt)).text, "done");
      await rt.call("billing.waive", { what: "seats", reason: "friend", people: ["bob"] }, {
        actor: staff,
      });
      await rt.call("billing.waive", { what: "usage", reason: "internal" }, { actor: staff });
      const waived = await stateOf<{ plan: { waived: { seats: { people: string[] } } } }>(rt);
      assertEquals(waived.plan.waived.seats.people, ["bob"]);
      assertEquals((await ask(rt)).text, "done");
      await rt.call("billing.waive", { what: "usage", lift: true }, { actor: staff });
      await rt.call("billing.waive", { what: "seats", lift: true }, { actor: staff });
      const lifted = await stateOf<{ plan: { waived?: { usage?: unknown; seats?: unknown } } }>(rt);
      assertEquals([lifted.plan.waived?.usage, lifted.plan.waived?.seats], [undefined, undefined]);
      // $2, less the one call before the waiver; the one during it was given back.
      assertAlmostEquals(lifted.balance, 1);
      await rt.call("billing.setPlan", { name: "team", seats: 3 }, { actor: staff });
      await rt.call("billing.setPlan", { name: "team", seats: null }, { actor: staff });
      assertEquals((await stateOf<{ seats: number }>(rt)).seats, 2);
      await rt.call("billing.budget", { usd: null }, { actor: ana });
      assertEquals((await stateOf<{ month: { limit?: number } }>(rt)).month.limit, undefined);
    } finally {
      await rt.close();
      await pool.close();
    }
  },
});
