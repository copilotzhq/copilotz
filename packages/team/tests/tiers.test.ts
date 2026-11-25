/**
 * Tiers as templates: every agent does a kind of work, and the tier in force
 * (the chat's, the person's default, the space's, the org's, the plan's)
 * gives that kind its model chain; the org customizes tiers, makes new ones,
 * takes them away and adds kinds of work; a cap bounds what members choose;
 * agents people make do a kind too; what a page reads; and every model call
 * says its space.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  personOf,
  type Runtime,
  type Store,
} from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { sqliteStore } from "copilotz/stores/sqlite";
import models, { type LlmAdapter, type ModelUse } from "copilotz/plugins/models";
import { chat, type Message } from "copilotz/plugins/agents";
import { team } from "../team/mod.ts";
import { type AgentNow, type HarnessShown, type Shown, tiers } from "../tiers/mod.ts";
import { plansFor } from "../tiers/shared/plans.ts";
import { ORG } from "copilotz/plugins/access/contract";
import { access } from "copilotz/plugins/access";
import { usage } from "copilotz/plugins/billing";
import { join } from "./join.ts";
import { tempFile, test } from "copilotz/testing";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };

/**
 * Every model call, as its adapter was sent it; `broken` fails before writing
 * anything, and so does a plan at its limit (`limited`).
 */
const calls: { model: string; effort?: string; maxTokens?: number }[] = [];
const uses: ModelUse[] = [];
const limited = new Set<string>();
const script: LlmAdapter = {
  async *generate({ connection, effort, maxTokens }) {
    calls.push({
      model: connection.model,
      ...(effort ? { effort } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
    if (connection.model === "broken") throw new Error("This model is down");
    if (limited.has(connection.model)) {
      throw Object.assign(new Error("Usage limit reached"), { code: "engine_limit" });
    }
    yield { type: "text", text: `from ${connection.model}` };
    yield { type: "usage", input: 100, output: 10 };
  },
};

/** The tier the org's plan gives, as a plan would say it. */
let planTier: string | null = null;

/** Each person's plans, connected now, as the plugins that keep them would say. */
const connected: Record<string, string[]> = {};

/** A person's plan on the script: the models it serves, each by its own name (`plan-opus`). */
const plan = (order: number, title: string, name: string, models: string[]) => ({
  adapter: "s",
  title,
  tags: { paid: "subscription" },
  harness: {
    order,
    plan: name,
    serves: Object.fromEntries(models.map((m) => [`s/${m}`, `plan-${m}`])),
  },
});

/** Plans, as an app's plugins declare them: two ways for one plan, and one no tier uses. */
const PLANS = {
  "h-claude": plan(10, "Claude plan", "Claude", ["opus", "sonnet", "haiku"]),
  "h-chatgpt": plan(20, "ChatGPT plan", "ChatGPT", ["sol"]),
  "h-codex": plan(30, "ChatGPT plan, through Codex", "ChatGPT", ["sol"]),
  "h-grok": plan(40, "Grok plan", "Grok", ["grok"]),
};

const TIERS = {
  everyday: {
    title: "Everyday",
    description: "Quick answers, routine work, volume",
    order: 1,
    agents: { north: "s/haiku" },
  },
  expert: {
    title: "Expert",
    description: "Hard problems, decisions that matter",
    order: 3,
    agents: {
      north: [{ model: "s/opus", effort: "medium" }, "s/sol"],
      east: { model: "s/sonnet", effort: "high" },
    },
  },
};

async function start(
  more: {
    prices?: boolean;
    store?: Store;
    tiers?: Record<string, unknown>;
    joined?: boolean;
    plans?: boolean;
  } = {},
) {
  calls.length = 0;
  uses.length = 0;
  limited.clear();
  for (const person of Object.keys(connected)) delete connected[person];
  planTier = null;
  const rt = await createRuntime({
    store: more.store ?? memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      team,
      tiers,
      ...(more.prices ? [usage] : []),
      definePlugin({
        name: "app",
        adapters: { llm: { s: script } },
        actions: {
          "test.planTier": defineAction({
            record: false,
            input: { type: "object" },
            run: () => planTier,
          }),
          "test.plans": defineAction({
            record: false,
            run: (ctx) => connected[personOf(ctx.actor) ?? ""] ?? [],
          }),
          // The plans `actor`'s person can run now, in their order, as a page prices them.
          "test.plansFor": defineAction({
            input: { type: "object" },
            run: (ctx, input: { actor: Actor; mine?: string[] }) =>
              plansFor(ctx.as(input.actor), input.mine),
          }),
          // The chain a turn of `actor`'s gets, as chat asks for it.
          "test.model": defineAction({
            input: { type: "object" },
            run: (ctx, input: { actor: Actor; agent: string }) =>
              ctx.as(input.actor).call("tiers.model", { agent: input.agent }),
          }),
        },
        resources: {
          shared: { thread: {}, message: {} },
          // Providers the catalog knows, on the script: their models' efforts are the catalog's.
          provider: {
            s: { adapter: "s", apiKey: "k" },
            anthropic: { adapter: "s", apiKey: "k" },
            google: { adapter: "s", apiKey: "k" },
            ...(more.plans ? PLANS : {}),
          },
          ...(more.plans ? { connectedPlans: { test: { action: "test.plans" } } } : {}),
          agents: {
            north: { instructions: "I lead.", model: "s/own-north", default: true },
            east: { instructions: "I build.", model: "s/own-east", default: true },
          },
          tiers: more.tiers ?? TIERS,
          planTier: { action: "test.planTier" },
          modelUse: { test: { used: (_: unknown, use: ModelUse) => void uses.push(use) } },
          ...(more.prices
            ? {
              cost: { "s/*": { input: 1, cached: 0.1, output: 5 } },
              price: { "*": { margin: 0.2 } },
            }
            : {}),
        },
      }),
    ],
  });
  if (more.joined) return rt;
  await rt.call("org.join", { person: "ana", role: "owner" });
  await rt.call("org.join", { person: "bob" });
  await rt.call("org.join", { person: "cy" });
  return rt;
}

const spaceOf = async (rt: Runtime, name: string, by: Actor) =>
  (await rt.call<{ space: string }>("space.create", { name }, { actor: by })).space;

/** The model an agent's reply came from, asked in a new chat in `space`. */
async function asked(rt: Runtime, space: string, agent = "north", actor = ana) {
  const { thread } = await rt.call<{ thread: string }>("chat.send", {
    text: `@${agent} hi`,
    in: space,
  }, { actor });
  await rt.idle();
  const history = await rt.query<Message[]>("message.history", { thread }, { actor });
  return history.at(-1)!.text!.replace("from ", "");
}

const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

/** A chat in `space`, and what its reply came from; then again in the same chat. */
async function chatIn(rt: Runtime, space: string, actor = ana) {
  const { thread } = await rt.call<{ thread: string }>("chat.send", {
    text: "@north hi",
    in: space,
  }, { actor });
  await rt.idle();
  const last = async () =>
    (await rt.query<Message[]>("message.history", { thread }, { actor })).at(-1)!.text!
      .replace("from ", "");
  return {
    thread,
    first: await last(),
    again: async () => {
      await rt.call("chat.send", { thread, text: "@north again" }, { actor });
      await rt.idle();
      return await last();
    },
  };
}

test("which tier: the chat's, the person's default, the space's, the org's, the plan's", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    assertEquals(await asked(rt, launch), "haiku", "nothing chosen: the app's first tier");
    planTier = "expert";
    assertEquals(await asked(rt, launch), "opus", "the plan's tier");
    assertEquals(calls.at(-1), { model: "opus", effort: "medium" }, "with its settings");
    await rt.call("tiers.choose", { tier: "everyday" }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku", "the org's");
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "the space's, over the org's");
    await rt.call("tiers.choose", { tier: "everyday", mine: true }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku", "the person's own default, over the space's");
    await join(rt, launch, bob, "editor", ana);
    assertEquals(await asked(rt, launch, "north", bob), "opus", "someone else's isn't");
    const chat = await chatIn(rt, launch);
    assertEquals(chat.first, "haiku");
    await rt.call("tiers.choose", { thread: chat.thread, tier: "expert" }, { actor: ana });
    assertEquals(await chat.again(), "opus", "the chat's, over everything");

    // Back, one step at a time.
    await rt.call("tiers.choose", { thread: chat.thread, tier: null }, { actor: ana });
    assertEquals(await chat.again(), "haiku");
    await rt.call("tiers.choose", { tier: null, mine: true }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "the space's again");
    // Other spaces never saw Launch's choices.
    const other = await spaceOf(rt, "Other", ana);
    assertEquals(await asked(rt, other), "haiku");
  } finally {
    await rt.close();
  }
});

test("a chain falls back in order; a kind a tier doesn't name keeps the agent's own model", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.save", { tier: "expert", kinds: { north: ["s/broken", "s/sonnet"] } }, {
      actor: ana,
    });
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    calls.length = 0;
    assertEquals(await asked(rt, launch), "sonnet");
    assertEquals(calls.map((c) => c.model), ["broken", "sonnet"]);
    // Everyday names no builder: East thinks with its own.
    await rt.call("tiers.choose", { tier: "everyday" }, { actor: ana });
    assertEquals(await rt.call("tiers.model", { agent: "east", space: launch }), null);
    assertEquals(await asked(rt, launch, "east"), "own-east");
  } finally {
    await rt.close();
  }
});

test("a chain set by hand keeps the maxTokens and effort of the one it replaces, where taken", async () => {
  const withSettings = {
    ...TIERS,
    expert: {
      ...TIERS.expert,
      agents: {
        ...TIERS.expert.agents,
        north: { model: "anthropic/claude-opus-5-5", effort: "medium", maxTokens: 30_000 },
      },
    },
  };
  const rt = await start({ tiers: withSettings });
  try {
    await rt.call("tiers.save", {
      tier: "expert",
      kinds: { north: ["anthropic/claude-sonnet-5-5", "s/plain"] },
    }, { actor: ana });
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    assertEquals(await rt.call("tiers.model", { agent: "north" }), [
      { model: "anthropic/claude-sonnet-5-5", maxTokens: 30_000, effort: "medium" },
      { model: "s/plain", maxTokens: 30_000 },
    ]);
  } finally {
    await rt.close();
  }
});

test("a choice keeps a tier's name: retuning the tier moves everyone on it", async () => {
  const path = tempFile(".sqlite");
  const before = await start({ store: await sqliteStore({ path }) });
  const launch = await spaceOf(before, "Launch", ana);
  try {
    await before.call("tiers.choose", { space: launch, tier: "everyday" }, { actor: ana });
    assertEquals(await asked(before, launch), "haiku");
  } finally {
    await before.close();
  }
  const retuned = { ...TIERS, everyday: { ...TIERS.everyday, agents: { north: "s/luna" } } };
  const after = await start({ store: await sqliteStore({ path }), tiers: retuned, joined: true });
  try {
    assertEquals(await asked(after, launch), "luna");
  } finally {
    await after.close();
  }
});

test("the org's tiers: customized, made, taken away and put back", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    // Its version of one of the app's.
    await rt.call("tiers.save", { tier: "everyday", kinds: { north: ["s/fable"] } }, {
      actor: ana,
    });
    assertEquals(await asked(rt, launch), "fable");
    let shown = await rt.query<Shown>("modelChoice.offered", {}, { actor: ana });
    assertEquals(shown.tiers.find((t) => t.name === "everyday")?.changed, true);
    await rt.call("tiers.restore", { tier: "everyday" }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku", "back as the app has it");

    // A new one, from another, mixing models.
    const { tier } = await rt.call<{ tier: string }>("tiers.save", {
      title: "Balanced",
      from: "expert",
      kinds: { east: ["s/haiku"] },
    }, { actor: ana });
    assertEquals(tier, "balanced");
    await rt.call("tiers.choose", { tier }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "North as Expert has it");
    assertEquals(await asked(rt, launch, "east"), "haiku", "East its own way");
    shown = await rt.query<Shown>("modelChoice.offered", {}, { actor: ana });
    assertEquals(shown.tiers.map((t) => [t.name, !!t.made]), [
      ["everyday", false],
      ["expert", false],
      ["balanced", true],
    ]);

    // Taken away: where it was chosen, what's above applies; put back, it's there again.
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: ana });
    await rt.call("tiers.remove", { tier: "expert" }, { actor: ana });
    shown = await rt.query<Shown>("modelChoice.offered", { space: launch }, { actor: ana });
    assertEquals(shown.tiers.map((t) => t.name), ["everyday", "balanced"]);
    assertEquals(shown.removed, [{ name: "expert", title: "Expert" }]);
    assertEquals(shown.now, { tier: "balanced", by: "org" });
    await rt.call("tiers.restore", { tier: "expert" }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "the space's choice again");
    // One the org made is deleted; the last can't go.
    await rt.call("tiers.remove", { tier: "balanced" }, { actor: ana });
    await rt.call("tiers.remove", { tier: "expert" }, { actor: ana });
    assertEquals(
      await refused(rt.call("tiers.remove", { tier: "everyday" }, { actor: ana })),
      "invalid",
    );
  } finally {
    await rt.close();
  }
});

test("kinds of work: an org's own, from one of the app's; agents people make do one", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    // An agent made without a kind does the app's first; one with a kind, that one's.
    const { agent: maya } = await rt.call<{ agent: string }>("agent.create", {
      name: "Maya",
      in: launch,
    }, { actor: ana });
    assertEquals(await rt.call("tiers.model", { agent: maya, space: launch }), [
      { model: "s/opus", effort: "medium" },
      "s/sol",
    ]);
    const { kind } = await rt.call<{ kind: string }>("tiers.kind", {
      title: "Numbers",
      base: "east",
    }, { actor: ana });
    assertEquals(kind, "numbers");
    const { agent: ledger } = await rt.call<{ agent: string }>("agent.create", {
      name: "Ledger",
      in: ORG,
      like: kind,
    }, { actor: ana });
    await rt.call("member.set", {
      space: launch,
      member: { kind: "agent", id: ledger },
      role: "editor",
    }, { actor: ana }).catch(() => {});
    assertEquals(await rt.call("tiers.model", { agent: kind, space: launch }), {
      model: "s/sonnet",
      effort: "high",
    }, "its base's chain, until the tier names it");
    await rt.call("tiers.save", { tier: "expert", kinds: { numbers: ["s/sol"] } }, { actor: ana });
    assertEquals(await asked(rt, launch, ledger), "sol");
    const shown = await rt.query<Shown>("modelChoice.offered", {}, { actor: ana });
    assertEquals(shown.kinds.map((k) => [k.kind, k.title, k.base ?? null]), [
      ["north", "North", null],
      ["east", "East", null],
      ["numbers", "Numbers", "east"],
    ]);
  } finally {
    await rt.close();
  }
});

test("who may: owners and admins change the org's tiers and its cap; members choose within it", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await join(rt, launch, bob, "editor", ana);
    // Each call made as it's awaited: one refused while another was still awaited would go
    // unhandled.
    for (
      const call of [
        () => rt.call("tiers.choose", { tier: "expert" }, { actor: bob }),
        () => rt.call("tiers.save", { tier: "expert", kinds: { north: ["s/x"] } }, { actor: bob }),
        () => rt.call("tiers.remove", { tier: "expert" }, { actor: bob }),
        () => rt.call("tiers.cap", { tier: "everyday" }, { actor: bob }),
        () => rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: bob }),
      ]
    ) assertEquals(await refused(call()), "forbidden");
    // An agent working for the owner doesn't choose for them: in person only.
    const north: Actor = { kind: "agent", id: "north", for: ana };
    assertEquals(
      await refused(rt.call("tiers.choose", { tier: "expert" }, { actor: north })),
      "forbidden",
    );

    // Within the cap, members choose for their chats and themselves.
    await rt.call("tiers.cap", { tier: "everyday" }, { actor: ana });
    assertEquals(
      await refused(rt.call("tiers.choose", { tier: "expert", mine: true }, { actor: bob })),
      "forbidden",
    );
    await rt.call("tiers.choose", { tier: "everyday", mine: true }, { actor: bob });
    const chat = await chatIn(rt, launch, bob);
    assertEquals(
      await refused(
        rt.call("tiers.choose", { thread: chat.thread, tier: "expert" }, { actor: bob }),
      ),
      "forbidden",
    );
    // The owner isn't bound by it.
    await rt.call("tiers.choose", { thread: chat.thread, tier: "expert" }, { actor: ana });
    assertEquals(await chat.again(), "opus");
    // Someone outside a chat doesn't change it.
    assertEquals(
      await refused(rt.call("tiers.choose", { thread: chat.thread, tier: null }, { actor: cy })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});

test("what a page reads: the org's tiers and kinds, prices, each level's choice and what applies", async () => {
  const rt = await start({ prices: true });
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    planTier = "everyday";
    await join(rt, launch, bob, "editor", ana);
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: ana });
    const org = await rt.query<Shown>("modelChoice.offered", {}, { actor: ana });
    assertEquals(org.tiers.map((t) => [t.name, t.title]), [["everyday", "Everyday"], [
      "expert",
      "Expert",
    ]]);
    assertEquals(org.tiers[1].kinds.map((k) => [k.kind, k.model.id, k.model.effort ?? null]), [
      ["north", "s/opus", "medium"],
      ["east", "s/sonnet", "high"],
    ]);
    assertEquals(org.tiers[1].kinds[0].model.fallbacks, [{ id: "s/sol", name: "sol" }]);
    assert(org.tiers.every((t) => t.price! > 0), "each priced a reply, at the org's prices");
    assertEquals(org.per, "reply");
    assertEquals(org.kinds.map((k) => [k.kind, k.agents.map((a) => a.agent)]), [
      ["north", ["north"]],
      ["east", ["east"]],
    ]);
    assertEquals([org.plan, org.org, org.now], ["everyday", { tier: null, cap: null }, {
      tier: "everyday",
      by: "plan",
    }]);
    const here = await rt.query<Shown>("modelChoice.offered", { space: launch }, { actor: bob });
    assertEquals([here.space, here.now], [{ tier: "expert" }, { tier: "expert", by: "space" }]);
    const now = await rt.query<AgentNow>("modelChoice.agent", { agent: "north", space: launch }, {
      actor: ana,
    });
    assertEquals([now.kind, now.tier, now.by, now.model.id], [
      "north",
      "expert",
      "space",
      "s/opus",
    ]);
  } finally {
    await rt.close();
  }
});

test("plans first: a turn runs on its person's plans, in their order, then the APIs", async () => {
  const rt = await start({ plans: true });
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    const north = (person: Actor) =>
      rt.call("test.model", { actor: { kind: "agent", id: "north", for: person }, agent: "north" });
    const chain = TIERS.expert.agents.north;
    // Nothing connected: the chain as the tier has it, on the APIs.
    assertEquals(await north(ana), { model: chain, harnesses: [] });
    assertEquals(await asked(rt, launch), "opus");
    // Only ChatGPT: it runs on it before any API.
    connected.ana = ["h-chatgpt"];
    assertEquals(await north(ana), { model: chain, harnesses: ["h-chatgpt"] });
    assertEquals(await asked(rt, launch), "plan-sol");
    // Every plan of hers, in the default order: the tier's model order still decides.
    connected.ana = ["h-codex", "h-chatgpt", "h-claude"];
    assertEquals(await north(ana), {
      model: chain,
      harnesses: ["h-claude", "h-chatgpt", "h-codex"],
    });
    assertEquals(await asked(rt, launch), "plan-opus");
    // Her own order ranks the plans that serve one model.
    await rt.call("tiers.harnesses", { harnesses: ["h-codex"] }, { actor: ana });
    assertEquals(await north(ana), {
      model: chain,
      harnesses: ["h-codex", "h-claude", "h-chatgpt"],
    });
    assertEquals(
      await rt.call("models.check", { model: await north(ana), port: "llm" }),
      ["h-claude/plan-opus", "h-codex/plan-sol", "h-chatgpt/plan-sol", "s/opus", "s/sol"],
    );
    // What a page prices for her: the same plans, in the order she keeps.
    assertEquals(await rt.call("test.plansFor", { actor: ana, mine: ["h-chatgpt"] }), [
      "h-chatgpt",
      "h-claude",
      "h-codex",
    ]);
    // Someone with none, or a turn for nobody: the APIs.
    assertEquals(await rt.call("test.plansFor", { actor: bob }), []);
    assertEquals(await north(bob), { model: chain, harnesses: [] });
    assertEquals(await rt.call("tiers.model", { agent: "north" }), { model: chain, harnesses: [] });
  } finally {
    await rt.close();
  }
});

test("a plan at its limit moves the call to the next plan, not to the API", async () => {
  const rt = await start({ plans: true });
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    connected.ana = ["h-claude", "h-chatgpt"];
    limited.add("plan-opus");
    calls.length = 0;
    assertEquals(await asked(rt, launch), "plan-sol");
    assertEquals(calls.map((c) => c.model), ["plan-opus", "plan-sol"]);
    // Each plan's call with the tier's settings for its model.
    assertEquals(calls[0], { model: "plan-opus", effort: "medium" });
    // Said on its use: which plan didn't answer, and why.
    const used = uses.at(-1)!;
    assertEquals([used.subject, used.tags?.fallback, used.tags?.fallbackWhy], [
      "h-chatgpt/plan-sol",
      "h-claude/plan-opus",
      "engine_limit",
    ]);
  } finally {
    await rt.close();
  }
});

test("a person's order of their plans: kept beside their tier, and the app's plans to order", async () => {
  const rt = await start({ plans: true });
  try {
    const shown = () => rt.query<HarnessShown[]>("modelChoice.harnesses", {}, { actor: ana });
    // The plans a tier's model runs on, in the default order; Grok's serves none here. Each with
    // the first model, in tier order, it runs: what a test of it tries.
    assertEquals(await shown(), [
      {
        name: "h-claude",
        title: "Claude plan",
        plan: "Claude",
        connected: false,
        model: "h-claude/plan-haiku",
      },
      {
        name: "h-chatgpt",
        title: "ChatGPT plan",
        plan: "ChatGPT",
        connected: false,
        model: "h-chatgpt/plan-sol",
      },
      {
        name: "h-codex",
        title: "ChatGPT plan, through Codex",
        plan: "ChatGPT",
        connected: false,
        model: "h-codex/plan-sol",
      },
    ]);
    connected.ana = ["h-chatgpt"];
    await rt.call("tiers.choose", { tier: "expert", mine: true }, { actor: ana });
    assertEquals(
      await rt.call("tiers.harnesses", { harnesses: ["h-codex", "h-chatgpt", "h-codex"] }, {
        actor: ana,
      }),
      { harnesses: ["h-codex", "h-chatgpt"] },
    );
    assertEquals((await shown()).map((h) => [h.name, h.connected]), [
      ["h-codex", false],
      ["h-chatgpt", true],
      ["h-claude", false],
    ]);
    // Her tier for new chats, cleared, leaves her order; her order, cleared, leaves her tier.
    await rt.call("tiers.choose", { tier: null, mine: true }, { actor: ana });
    assertEquals((await shown())[0].name, "h-codex");
    await rt.call("tiers.choose", { tier: "expert", mine: true }, { actor: ana });
    assertEquals(await rt.call("tiers.harnesses", { harnesses: null }, { actor: ana }), {
      harnesses: null,
    });
    assertEquals((await shown())[0].name, "h-claude");
    const mine = await rt.query<Shown>("modelChoice.offered", {}, { actor: ana });
    assertEquals(mine.person, { tier: "expert" });
    // Only the app's plans, and only by the person themselves.
    assertEquals(
      await refused(rt.call("tiers.harnesses", { harnesses: ["s"] }, { actor: ana })),
      "invalid",
    );
    assertEquals(
      await refused(rt.call("tiers.harnesses", { harnesses: [] }, {
        actor: { kind: "agent", id: "north", for: ana },
      })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});

test("every model call says its space, beside its thread, agent and turn", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await asked(rt, launch);
    const tags = uses.at(-1)!.tags!;
    assertEquals([tags.space, tags.agent], [launch, "north"]);
    assert(tags.thread && tags.turn);
  } finally {
    await rt.close();
  }
});

test("a tier with a model the app can't call stops the app starting", async () => {
  const bad = (agents: Record<string, unknown>) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        tiers,
        definePlugin({
          name: "app",
          adapters: { llm: { s: script } },
          resources: {
            provider: { s: { adapter: "s" } },
            agents: { north: { instructions: "Hi.", model: "s/x" } },
            tiers: { odd: { title: "Odd", agents } },
          },
        }),
      ],
    });
  await assertRejects(() => bad({ north: "elsewhere/x" }), Error, `Tier "odd", north`);
});
