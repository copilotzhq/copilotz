/**
 * The usage ledger: every model call is metered and rated as it's recorded
 * (cost from the app's rates or the catalog, price from the app's only), an
 * app records its own uses (usage.record), totals group by any field or tag,
 * and re-rating appends adjustments.
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Store,
} from "../../../runtime/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import usage, { rate, type UsageRecord } from "../usage/mod.ts";
import { catalog } from "../../models/shared/choice.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const MILLION = 1_000_000;
const books = (cost?: Record<string, unknown>, price?: Record<string, unknown>) => ({
  resources: { ...(cost ? { cost } : {}), ...(price ? { price } : {}) },
  // The models plugin answers what the catalog says a model costs.
  call: <R>(action: string, input?: unknown) =>
    Promise.resolve(models.actions![action].run({} as never, input) as R),
});
const use = (subject: string, quantities: Record<string, number>, catalogId?: string) => ({
  meter: "llm",
  subject,
  quantities,
  ...(catalogId ? { catalog: catalogId } : {}),
  at: "2026-11-02T10:00:00Z",
});

test("cost from the catalog: each kind of token at its own price", async () => {
  // gpt-5.4-mini: 0.75 input, 0.075 cached, 4.5 output per million.
  const rated = await rate(
    books(),
    use("openai/gpt-5.4-mini", {
      input: MILLION,
      cached: 400_000,
      output: MILLION,
      reasoning: 200_000,
    }, "openai/gpt-5.4-mini"),
  );
  // Reasoning has no price of its own: it's output.
  assertAlmostEquals(rated.cost!, 0.6 * 0.75 + 0.4 * 0.075 + 4.5);
  assertEquals(rated.costs, { input: 0.45, cached: 0.03, output: 4.5 });
  // No price book: the price is the cost (a margin of 0).
  assertEquals([rated.price, rated.prices], [rated.cost, rated.costs]);
  assertEquals(rated.rated, { cost: `models.dev ${catalog.fetched}`, price: "cost" });
  // Its cached tokens at input's price would have come to 0.3, not 0.03.
  assertEquals(rated.saved, { cost: 0.27, price: 0.27 });
  assertEquals(rated.unpriced, undefined);
});

test("past a prompt size, a tier's prices apply", async () => {
  const sol = catalog.providers.openai.models["gpt-6.1-sol"].cost!;
  const tier = sol.tiers![0];
  const small = await rate(
    books(),
    use("openai/gpt-6.1-sol", { input: 1000 }, "openai/gpt-6.1-sol"),
  );
  const large = await rate(
    books(),
    use("openai/gpt-6.1-sol", { input: tier.above + 1 }, "openai/gpt-6.1-sol"),
  );
  assertAlmostEquals(small.cost!, 1000 * sol.input! / MILLION);
  assertAlmostEquals(large.cost!, (tier.above + 1) * tier.input! / MILLION);
});

test("the app's rates win, by subject, then provider, and from their date", async () => {
  const cost = {
    "openai/gpt-5.4-mini": [
      { input: 1, output: 2 },
      { since: "2026-11-01", input: 0.5, output: 1 },
      { since: "2027-01-01", input: 0.1, output: 0.1 },
    ],
    // A subscription: nothing per token.
    "chatgpt/*": { input: 0, output: 0 },
    // Seconds, per minute.
    "compute/terminal": { seconds: 0.06, per: 60 },
    "*": { input: 9, output: 9 },
  };
  const q = { input: MILLION, output: MILLION };
  assertEquals(
    (await rate(books(cost), use("openai/gpt-5.4-mini", q, "openai/gpt-5.4-mini"))).cost,
    1.5,
  );
  assertEquals(
    (await rate(books(cost), use("chatgpt/gpt-6.1-sol", q, "openai/gpt-6.1-sol"))).cost,
    0,
  );
  assertEquals((await rate(books(cost), use("compute/terminal", { seconds: 120 }))).cost, 0.12);
  // The catalog before "*": "*" is for what nothing else knows.
  const known = await rate(
    books(cost),
    use("deepseek/deepseek-v4-flash", q, "deepseek/deepseek-v4-flash"),
  );
  assertEquals(known.rated.cost, `models.dev ${catalog.fetched}`);
  assertEquals((await rate(books(cost), use("mine/model", q))).cost, 18);
});

test("price: the cost, a margin on it, or the app's own rates; what nothing prices is flagged", async () => {
  const price = {
    // A gross margin of 20%: the cost is 80% of the price.
    "openai/*": { margin: 0.2 },
    "compute/terminal": { seconds: 0.12, per: 60 },
    // 90%: ten times the cost.
    "cloud/*": { margin: 0.9 },
  };
  const q = { input: MILLION, output: 0 };
  const marked = await rate(
    books(undefined, price),
    use("openai/gpt-5.4-mini", q, "openai/gpt-5.4-mini"),
  );
  assertEquals([marked.cost, marked.price, marked.rated.price], [0.75, 0.9375, "app"]);
  assertEquals(marked.prices, { input: 0.9375 });
  const cloud = await rate(books({ "cloud/*": { seconds: 0.36, per: 3600 } }, price), {
    ...use("cloud/small", { seconds: 600 }),
    meter: "compute",
  });
  assertEquals([cloud.cost, cloud.price], [0.06, 0.6]);
  // Nothing in the price book for it: at cost.
  const atCost = await rate(
    books(undefined, price),
    use("anthropic/claude-haiku-5-5", q, "anthropic/claude-haiku-5-5"),
  );
  assertEquals([atCost.price, atCost.rated.price], [atCost.cost, "cost"]);
  // A margin of 100% or more can't be: unpriced.
  assertEquals(
    (await rate(
      books(undefined, { "*": { margin: 1 } }),
      use("openai/gpt-5.4-mini", q, "openai/gpt-5.4-mini"),
    ))
      .unpriced,
    ["price"],
  );
  const terminal = await rate(books({ "compute/*": { seconds: 0.06, per: 60 } }, price), {
    ...use("compute/terminal", { seconds: 60 }),
    meter: "compute",
  });
  assertEquals([terminal.cost, terminal.price], [0.06, 0.12]);
  // No rate and no catalog entry: recorded, flagged.
  assertEquals((await rate(books(undefined, price), use("mine/model", q))).unpriced, [
    "cost",
    "price",
  ]);
  // A unit with no price can't be priced either (nor its price, at cost).
  assertEquals(
    (await rate(books({ "x/y": { input: 1 } }), use("x/y", { input: 1, seconds: 3 }))).unpriced,
    ["cost", "price"],
  );
});

/** A runtime with a scripted model on provider `script`, which the app prices. */
async function started(store: Store, more: Plugin[] = []) {
  const script: LlmAdapter = {
    async *generate({ messages }) {
      const last = messages.at(-1)!;
      if (last.role === "tool") yield { type: "text", text: "rolled" };
      else yield { type: "tool_call", call: { id: crypto.randomUUID(), name: "roll", input: {} } };
      yield { type: "usage", input: 1000, output: 100, cached: 600 };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { script: { adapter: "script" } },
      cost: { "script/*": { input: 1, cached: 0.1, output: 2 } },
      // Half the price is margin: twice the cost.
      price: { "*": { margin: 0.5 } },
      agents: { lead: { instructions: "Roll.", model: "script/lead" } },
      tools: { roll: { description: "Roll.", run: () => 4 } },
    },
    adapters: { llm: { script } },
  });
  return await createRuntime({ store, plugins: [models, chat, usage, app, ...more] });
}

test("a chat turn's model calls are metered, tagged with its thread, agent and turn", async () => {
  const runtime = await started(await sqliteStore({ path: tempFile() }));
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      text: "roll",
      from: "ana",
    });
    await runtime.idle();
    const records = await runtime.query<UsageRecord[]>("usage.list");
    // Two calls: the step with the tool, then the answer.
    assertEquals(records.length, 2);
    const [first] = records;
    assertEquals([first.meter, first.subject, first.quantities], [
      "llm",
      "script/lead",
      { input: 1000, output: 100, cached: 600 },
    ]);
    assertEquals([first.tags?.thread, first.tags?.agent], [thread, "lead"]);
    // (400 × 1 + 600 × 0.1 + 100 × 2) per million; the price doubles it.
    assertAlmostEquals(first.cost!, 660 / MILLION);
    assertAlmostEquals(first.price!, 1320 / MILLION);
    const [byAgent] = await runtime.query<
      {
        key: Record<string, string>;
        cost: number;
        uses: number;
        quantities: Record<string, number>;
      }[]
    >("usage.totals", { filter: { "tags.thread": thread }, by: ["tags.agent"] });
    assertEquals([byAgent.key, byAgent.uses, byAgent.quantities.input], [
      { "tags.agent": "lead" },
      2,
      2000,
    ]);
    assertAlmostEquals(byAgent.cost, 2 * 660 / MILLION);
  } finally {
    await runtime.close();
  }
});

test("each person sees their own usage; the system, everyone's", async () => {
  const runtime = await started(await sqliteStore({ path: tempFile() }));
  const ana = { kind: "person", id: "ana" };
  const bob = { kind: "person", id: "bob" };
  try {
    await runtime.call("chat.send", { text: "roll" }, { actor: ana });
    await runtime.call("chat.send", { text: "roll" }, { actor: bob });
    await runtime.idle();
    const records = await runtime.query<UsageRecord[]>("usage.list");
    assertEquals(records.map((r) => r.tags?.person).sort(), ["ana", "ana", "bob", "bob"]);
    const uses = async (actor?: { kind: string; id: string }) =>
      (await runtime.query<{ uses: number }[]>("usage.totals", {}, actor ? { actor } : {}))
        .reduce((n, t) => n + t.uses, 0);
    assertEquals([await uses(ana), await uses(bob), await uses()], [2, 2, 4]);
    // Asking for someone else's is asking for one's own.
    const asked = await runtime.query<{ uses: number }[]>(
      "usage.totals",
      { filter: { "tags.person": "bob" } },
      { actor: ana },
    );
    assertEquals(asked.reduce((n, t) => n + t.uses, 0), 2);
  } finally {
    await runtime.close();
  }
});

test("an app records its own uses, priced by its own rates", async () => {
  const machines = definePlugin({
    name: "machines",
    resources: { cost: { "compute/small": { seconds: 0.001, per: 1 } } },
    actions: {
      "tool.used": defineAction({
        input: { type: "object" },
        run: (ctx) =>
          ctx.call("usage.record", { meter: "tool", subject: "search", quantities: { calls: 1 } }),
      }),
      "machine.ran": defineAction({
        input: { type: "object", properties: { seconds: { type: "number" } } },
        run: (ctx, input) =>
          ctx.call("usage.record", {
            meter: "compute",
            subject: "compute/small",
            quantities: { seconds: input.seconds },
            tags: { space: "s1" },
          }),
      }),
    },
  });
  const runtime = await started(await sqliteStore({ path: tempFile() }), [machines]);
  try {
    await runtime.call("tool.used", {});
    await runtime.call("machine.ran", { seconds: 30 });
    await runtime.call("machine.ran", { seconds: 15 });
    const records = await runtime.query<UsageRecord[]>("usage.list", {
      filter: { meter: { $in: ["tool", "compute"] } },
    });
    const compute = records.filter((r) => r.meter === "compute");
    assertEquals(compute.map((r) => r.quantities.seconds).sort(), [15, 30]);
    assertEquals(compute.map((r) => r.cost).sort(), [0.015, 0.03]);
    assertEquals(compute[0].tags, { space: "s1" });
    // Nothing prices a tool call: flagged, and counted as such.
    const [tool] = records.filter((r) => r.meter === "tool");
    assertEquals(tool.unpriced, ["cost", "price"]);
    const totals = await runtime.query<
      { key: { meter: string }; uses: number; unpriced: number }[]
    >(
      "usage.totals",
      { by: ["meter"] },
    );
    assertEquals(
      totals.map((t) => [t.key.meter, t.uses, t.unpriced]).sort(),
      [["compute", 2, 0], ["tool", 1, 1]],
    );
  } finally {
    await runtime.close();
  }
});

test("re-rating appends adjustments, so totals follow new rates", async () => {
  const path = tempFile();
  const first = await started(await sqliteStore({ path }));
  await first.call("chat.send", { text: "roll", from: "ana" });
  await first.idle();
  await first.close();
  // Later, the provider's rates turn out to be half.
  const half = definePlugin({
    name: "half",
    resources: { cost: { "script/*": { input: 0.5, cached: 0.05, output: 1 } } },
  });
  const second = await started(await sqliteStore({ path }), [half]);
  try {
    assertEquals(await second.call("usage.rerate", { filter: { meter: "llm" } }), { adjusted: 2 });
    // Again: nothing more to adjust.
    assertEquals(await second.call("usage.rerate", { filter: { meter: "llm" } }), { adjusted: 0 });
    const [total] = await second.query<{ cost: number; price: number; uses: number }[]>(
      "usage.totals",
      { filter: { meter: "llm" } },
    );
    assertEquals(total.uses, 2);
    assertAlmostEquals(total.cost, 660 / MILLION);
    assertAlmostEquals(total.price, 1320 / MILLION);
    const records = await second.query<UsageRecord[]>("usage.list");
    assertEquals(records.filter((r) => r.adjusts).length, 2);
  } finally {
    await second.close();
  }
});

test("a use recorded before every use had a price is priced at its cost, and re-rated as such", async () => {
  const path = tempFile();
  // As the ledger kept one before: a cost, no price, nothing rated its price.
  const old = definePlugin({
    name: "old",
    actions: {
      "old.add": defineAction({
        input: { type: "object" },
        run: (ctx) =>
          ctx.record("usage", {
            meter: "llm",
            subject: "script/lead",
            quantities: { input: 1000, output: 100, cached: 600 },
            cost: 660 / MILLION,
            rated: { cost: "app" },
            at: "2026-10-29T12:00:00.000Z",
          }),
      }),
    },
  });
  const runtime = await started(await sqliteStore({ path }), [old]);
  try {
    await runtime.call("old.add", {});
    const [total] = await runtime.query<{ cost: number; price: number; uses: number }[]>(
      "usage.totals",
      { filter: { meter: "llm" } },
    );
    assertEquals(total.uses, 1);
    assertAlmostEquals(total.price, total.cost);
    // Re-rated, it's at the app's price now (twice its cost), and once.
    assertEquals(await runtime.call("usage.rerate", { filter: { meter: "llm" } }), { adjusted: 1 });
    const [after] = await runtime.query<{ cost: number; price: number }[]>("usage.totals", {
      filter: { meter: "llm" },
    });
    assertAlmostEquals(after.cost, 660 / MILLION);
    assertAlmostEquals(after.price, 1320 / MILLION);
  } finally {
    await runtime.close();
  }
});

test("totals sum cost and price by part, and what caching saved; people see prices only", async () => {
  const runtime = await started(await sqliteStore({ path: tempFile() }));
  const ana = { kind: "person", id: "ana" };
  try {
    await runtime.call("chat.send", { text: "roll" }, { actor: ana });
    await runtime.idle();
    const [all] = await runtime.query<
      {
        cost: number;
        price: number;
        costs: Record<string, number>;
        prices: Record<string, number>;
        saved: { cost: number; price: number };
      }[]
    >("usage.totals", {});
    // Two calls of 400 uncached × 1, 600 cached × 0.1 and 100 output × 2, per million.
    assertEquals(all.costs, { input: 800 / MILLION, cached: 120 / MILLION, output: 400 / MILLION });
    assertEquals(all.prices, {
      input: 1600 / MILLION,
      cached: 240 / MILLION,
      output: 800 / MILLION,
    });
    // Cached at input's price, 2 × 600 × (1 − 0.1).
    assertEquals(all.saved, { cost: 1080 / MILLION, price: 2160 / MILLION });
    const [mine] = await runtime.query<Record<string, unknown>[]>("usage.totals", {}, {
      actor: ana,
    });
    assertEquals([mine.cost, mine.costs, mine.saved], [undefined, undefined, {
      price: 2160 / MILLION,
    }]);
    assertAlmostEquals(mine.price as number, 2640 / MILLION);
  } finally {
    await runtime.close();
  }
});

test("a use on the org's own key costs the app nothing and is charged nothing, even when re-rated", async () => {
  const rated = await rate(
    books(undefined, { "*": { margin: 0.2 } }),
    {
      ...use("openai/gpt-5.4-mini", { input: MILLION }, "openai/gpt-5.4-mini"),
      tags: { paid: "own-key" },
    },
  );
  assertEquals([rated.cost, rated.price, rated.unpriced], [0, 0, undefined]);
  assertEquals(rated.rated, { cost: "own-key", price: "own-key" });

  const rt = await createRuntime({
    store: await sqliteStore({ path: tempFile() }),
    plugins: [
      models,
      usage,
      definePlugin({
        name: "app",
        resources: { price: { "*": { margin: 0.2 } } },
        actions: {
          "test.use": defineAction({
            input: { type: "object" },
            run: (ctx, input) => ctx.call("usage.record", input),
          }),
          "test.all": defineAction({
            input: { type: "object" },
            run: (ctx) => ctx.db.collection("usage").find({}),
          }),
        },
      }),
    ],
  });
  try {
    await rt.call("test.use", {
      meter: "llm",
      subject: "openai/gpt-5.4-mini",
      catalog: "openai/gpt-5.4-mini",
      quantities: { input: MILLION },
      tags: { paid: "own-key" },
    });
    assertEquals(await rt.call("usage.rerate", {}), { adjusted: 0 });
    const [record] = await rt.call<UsageRecord[]>("test.all", {});
    assertEquals([record.cost, record.price, record.quantities.input], [0, 0, MILLION]);
  } finally {
    await rt.close();
  }
});

test("an org's plan can name its own price list; none, or an unknown one, is the app's", async () => {
  const quiet = {
    resources: {
      price: { "*": { margin: 0.5 } },
      priceLists: { contract: { "*": { margin: 0.1 } } },
      usage: { priceList: "plan.prices" },
    },
  };
  const asked = (name: string | null) => ({
    ...quiet,
    call: <R>(action: string, input?: unknown) =>
      action === "plan.prices"
        ? Promise.resolve(name as R)
        : Promise.resolve(models.actions![action].run({} as never, input) as R),
  });
  const of = async (name: string | null) =>
    (await rate(
      asked(name),
      use("openai/gpt-5.4-mini", { input: MILLION }, "openai/gpt-5.4-mini"),
    )).price!;
  assertAlmostEquals(await of(null), 0.75 / 0.5);
  assertAlmostEquals(await of("contract"), 0.75 / 0.9);
  assertAlmostEquals(await of("gone"), 0.75 / 0.5);
});

test("the models on offer show what the org would be charged; on its own key, its provider's prices", async () => {
  const rt = await createRuntime({
    store: await sqliteStore({ path: tempFile() }),
    plugins: [
      models,
      usage,
      definePlugin({
        name: "app",
        resources: {
          provider: { openai: { apiKey: "the-apps-key" }, groq: {} },
          price: { "*": { margin: 0.2 } },
        },
      }),
    ],
  });
  try {
    const ana = { actor: { kind: "person", id: "ana" } as const };
    const { model } = await rt.call<
      { model: { price: { input: number; output: number }; ownKey?: boolean } }
    >("models.offered", { model: "openai/gpt-5.4-mini" }, ana);
    assertAlmostEquals(model.price.input, 0.75 / 0.8);
    assertAlmostEquals(model.price.output, 4.5 / 0.8);
    assertEquals(model.ownKey, undefined);
    const listed = catalog.providers.groq.models["llama-3.3-70b-versatile"].cost!;
    const own = await rt.call<
      { model: { price: { input: number }; ownKey?: boolean } }
    >("models.offered", { model: "groq/llama-3.3-70b-versatile" }, ana);
    assertEquals([own.model.price.input, own.model.ownKey], [listed.input, true]);
  } finally {
    await rt.close();
  }
});
