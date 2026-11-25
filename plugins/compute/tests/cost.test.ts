/**
 * What a computer the app keeps costs the person asking (`computer.cost`): an
 * hour awake at its size's price and how long it stays awake after, its disk
 * a month, how far the org plan's credits go at that, and, for one of
 * theirs, what this month came to so far (from the usage ledger). The app
 * says the prices (the `computerWake` resource's `prices` query); nothing is
 * priced here. A person's own machine, or an app that prices none, has none.
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import usage from "../../billing/usage/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type ComputerCost, type ComputerPrices, computers } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

/** The app's prices, as a cloud plugin's sizes query says them. */
const PRICES: ComputerPrices = {
  sizes: [{ id: "small", hour: 0.16 }, { id: "standard", hour: 0.41 }],
  disk: { gb: 10, gbMonth: 0.2 },
  warmMinutes: 10,
};

async function setup(
  options: { prices?: boolean; credits?: { amount: number; every: "once" | "month" } | null } = {},
) {
  const app = definePlugin({
    name: "app",
    collections: {
      cloudPrice: defineCollection({
        schema: { type: "object", properties: { size: { type: "string" } } },
        queries: { sizes: { allow: () => true, run: () => PRICES } },
      }),
    },
    actions: {
      "test.credits": defineAction({
        record: false,
        input: { type: "object" },
        run: () => options.credits ?? null,
      }),
    },
    resources: {
      ...(options.prices === false
        ? {}
        : { computerWake: { wake: "test.wake", prices: "cloudPrice.sizes" } }),
      planCredits: { action: "test.credits" },
      // A computer's hour as the ledger rates it (at cost: no price book).
      cost: { "cloud/small": { seconds: 0.16, per: 3600 }, "cloud/disk": { gbHours: 1, per: 1 } },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, usage, chat, ...access, computers, app],
  });
  const cost = (computer?: string) =>
    rt.query<ComputerCost | null>("computer.cost", computer ? { computer } : {}, { actor: ana });
  /** A computer of hers the app keeps (`status`), of this size; or (no size) her own machine. */
  const made = async (size?: string) => {
    const { id } = await rt.call<{ id: string }>("computer.provision", {
      owner: "ana",
      name: "Cloud",
    });
    if (size) await rt.call("computer.mark", { computer: id, status: { kind: "cloud", size } });
    return id;
  };
  return { rt, cost, made };
}

test("a new one: an hour at the first size's price, how long it stays awake, its disk, and how far credits go", async () => {
  const { rt, cost } = await setup({ credits: { amount: 5, every: "once" } });
  try {
    const priced = (await cost())!;
    assertEquals([priced.hour, priced.warmMinutes], [0.16, 10]);
    assertAlmostEquals(priced.diskMonth!, 2, 1e-9);
    // $5, less a month's $2 disk, at 16¢ an hour: about 18 hours.
    assertEquals(priced.covers, { hours: 18, amount: 5, every: "once" });
    assertEquals(priced.month, undefined, "a new one has no month yet");
  } finally {
    await rt.close();
  }
});

test("credits each month go as far; without credits, or with nothing past the disk, it doesn't say", async () => {
  for (
    const [credits, covers] of [
      [{ amount: 15, every: "month" }, { hours: 80, amount: 15, every: "month" }],
      [null, undefined],
      [{ amount: 2, every: "once" }, undefined],
    ] as const
  ) {
    const { rt, cost } = await setup({ credits });
    try {
      assertEquals((await cost())!.covers, covers, JSON.stringify(credits));
    } finally {
      await rt.close();
    }
  }
});

test("one of hers the app keeps: its size's price, and this month so far from the ledger", async () => {
  const { rt, cost, made } = await setup();
  try {
    const cloud = await made("small");
    const other = await made("small");
    const record = (computer: string, quantities: Record<string, number>, at?: string) =>
      rt.call("usage.record", {
        meter: "computer",
        subject: "seconds" in quantities ? "cloud/small" : "cloud/disk",
        quantities,
        tags: { computer, person: "ana" },
        ...(at ? { at } : {}),
      });
    await record(cloud, { seconds: 9600 }); // 2 h 40 min awake
    await record(cloud, { gbHours: 100 }); // its disk: not time awake
    await record(other, { seconds: 3600 }); // another computer's
    const lastMonth = new Date();
    lastMonth.setUTCDate(0); // the last day of last month
    await record(cloud, { seconds: 7200 }, lastMonth.toISOString());
    const priced = (await cost(cloud))!;
    assertEquals(priced.hour, 0.16);
    assertEquals(priced.month?.seconds, 9600);
    assertAlmostEquals(priced.month!.price, 0.16 * 9600 / 3600, 1e-6);
    // Another size: its price.
    assertEquals((await cost(await made("standard")))!.hour, 0.41);
  } finally {
    await rt.close();
  }
});

test("her own machine, a size the app doesn't price, or an app that prices none: no cost", async () => {
  const { rt, cost, made } = await setup();
  try {
    assertEquals(await cost(await made()), null, "her own machine");
    assertEquals(await cost(await made("huge")), null, "a size not offered");
    assertEquals(await cost("someone-elses"), null, "not hers");
  } finally {
    await rt.close();
  }
  const none = await setup({ prices: false });
  try {
    assertEquals(await none.cost(), null);
  } finally {
    await none.rt.close();
  }
});
