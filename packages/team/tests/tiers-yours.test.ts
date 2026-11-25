/**
 * What a typical reply comes to for the person looking, with their plans: each kind's chain
 * priced at the first model it would try for them (its plans first, as a turn of theirs goes),
 * one of their plans costing them nothing (`plan`, `yours`). What it costs on the app's models
 * (`price`) stays, for pages that choose for others. By plan set: none, ChatGPT only, Claude
 * only, both.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  personOf,
  type Runtime,
} from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import models, { type LlmAdapter } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { usage } from "copilotz/plugins/billing";
import { team } from "../team/mod.ts";
import { type Shown, tiers } from "../tiers/mod.ts";
import { test } from "copilotz/testing";

const ana: Actor = { kind: "person", id: "ana" };

const silent: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "unused" };
  },
};

/** A person's plan on the script: the models it serves, each by its own name. */
const plan = (order: number, name: string, served: string[]) => ({
  adapter: "s",
  title: `${name} plan`,
  tags: { paid: "subscription" },
  harness: {
    order,
    plan: name,
    serves: Object.fromEntries(served.map((m) => [`s/${m}`, `plan-${m}`])),
  },
});

/** Claude's models and GPT's, each kind trying one maker's, then the other's where it says. */
const TIERS = {
  everyday: {
    title: "Everyday",
    order: 1,
    agents: {
      north: ["s/haiku", "s/luna"],
      east: ["s/luna", "s/haiku"],
      west: "s/opus",
      south: "s/sol",
    },
  },
};

/** The plans each person has connected now. */
let connected: string[] = [];

async function start(): Promise<Runtime> {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      team,
      tiers,
      usage,
      definePlugin({
        name: "app",
        adapters: { llm: { s: silent } },
        actions: {
          "test.plans": defineAction({
            record: false,
            run: (ctx) => personOf(ctx.actor) === "ana" ? connected : [],
          }),
        },
        resources: {
          provider: {
            s: { adapter: "s", apiKey: "k" },
            "h-claude": plan(10, "Claude", ["haiku", "opus"]),
            "h-chatgpt": plan(20, "ChatGPT", ["luna", "sol"]),
          },
          connectedPlans: { test: { action: "test.plans" } },
          tiers: TIERS,
          // Each model its own price, so a kind's says which it was priced at.
          cost: {
            "s/haiku": { input: 1, output: 5 },
            "s/luna": { input: 2, output: 8 },
            "s/opus": { input: 5, output: 25 },
            "s/sol": { input: 3, output: 12 },
          },
        },
      }),
    ],
  });
  await rt.call("org.join", { person: "ana", role: "owner" });
  return rt;
}

const everyday = async (rt: Runtime) =>
  (await rt.query<Shown>("modelChoice.offered", {}, { actor: ana })).tiers[0];

/** Each kind's plan, as the person looking would run it. */
const plans = (tier: Shown["tiers"][number]) =>
  Object.fromEntries(tier.kinds.map((k) => [k.kind, k.model.plan ?? null]));

test("by plan set: none, ChatGPT only, Claude only, both; the app's price stays", async () => {
  const rt = await start();
  try {
    connected = [];
    const none = await everyday(rt);
    assertEquals(plans(none), { north: null, east: null, west: null, south: null });
    assertEquals(none.yours, undefined, "nothing of theirs answers: the app's price is theirs");
    const price = none.price!;
    const priceOf = (kind: string) => none.kinds.find((k) => k.kind === kind)!.model.price!;
    assert(price > 0);

    connected = ["h-chatgpt"];
    const chatgpt = await everyday(rt);
    // Plans first, through the chain: North's Haiku has no plan of hers, its next model has.
    assertEquals(plans(chatgpt), {
      north: "h-chatgpt/plan-luna",
      east: "h-chatgpt/plan-luna",
      west: null,
      south: "h-chatgpt/plan-sol",
    });
    // A reply's price is the kinds' average: only West's Opus costs her anything.
    assertAlmostEquals(chatgpt.yours!, priceOf("west") / 4, 1e-12);
    assertEquals(chatgpt.price, price);

    connected = ["h-claude"];
    const claude = await everyday(rt);
    assertEquals(plans(claude), {
      north: "h-claude/plan-haiku",
      east: "h-claude/plan-haiku",
      west: "h-claude/plan-opus",
      south: null,
    });
    assertAlmostEquals(claude.yours!, priceOf("south") / 4, 1e-12);

    connected = ["h-claude", "h-chatgpt"];
    const both = await everyday(rt);
    assertEquals(both.yours, 0, "on her plans: the model costs her nothing");
    assertEquals(both.price, price, "what it costs on the app's models stays");
  } finally {
    await rt.close();
  }
});
