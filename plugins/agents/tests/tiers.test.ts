/**
 * Tiers: which model each of the app's agents thinks with, the first that
 * applies of a space's pick, the space's tier, the org's pick, the org's tier
 * and the plan's; a pick keeps the tier's list behind it; a tier that doesn't
 * name an agent, and agents people make, keep their own; who may change what;
 * what a page reads, with where each model comes from and a typical reply's
 * price; and every model call says its space.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter, type ModelUse } from "../../models/mod.ts";
import { chat, type Message } from "../chat/mod.ts";
import { team } from "../team/mod.ts";
import { type AgentNow, type Shown, tiers } from "../tiers/mod.ts";
import { access } from "../../access/mod.ts";
import { usage } from "../../billing/mod.ts";
import { join } from "../../access/tests/join.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };

/** Every model call, as its adapter was sent it; `broken` fails before writing anything. */
const calls: { model: string; effort?: string; maxTokens?: number }[] = [];
const uses: ModelUse[] = [];
const script: LlmAdapter = {
  async *generate({ connection, effort, maxTokens }) {
    calls.push({
      model: connection.model,
      ...(effort ? { effort } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
    if (connection.model === "broken") throw new Error("This model is down");
    yield { type: "text", text: `from ${connection.model}` };
    yield { type: "usage", input: 100, output: 10 };
  },
};

/** The tier the org's plan gives, as a plan would say it. */
let planTier: string | null = null;

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
  more: { prices?: boolean; store?: Store; tiers?: typeof TIERS; joined?: boolean } = {},
) {
  calls.length = 0;
  uses.length = 0;
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
        },
        resources: {
          shared: { thread: {}, message: {} },
          // Providers the catalog knows, on the script: their models' efforts are the catalog's.
          provider: {
            s: { adapter: "s", apiKey: "k" },
            anthropic: { adapter: "s", apiKey: "k" },
            google: { adapter: "s", apiKey: "k" },
          },
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

test("who chooses: the space's pick, its tier, the org's pick, its tier, the plan's, else its own", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    assertEquals(await asked(rt, launch), "own-north", "nothing chosen: its own");
    planTier = "everyday";
    assertEquals(await asked(rt, launch), "haiku", "the plan's tier");
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "the org's tier");
    assertEquals(calls.at(-1), { model: "opus", effort: "medium" }, "with its settings");
    await rt.call("tiers.pick", { agent: "north", model: "s/sonnet" }, { actor: ana });
    assertEquals(await asked(rt, launch), "sonnet", "the org's pick");
    await rt.call("tiers.choose", { space: launch, tier: "everyday" }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku", "the space's tier, over the org's pick");
    await rt.call("tiers.pick", { space: launch, agent: "north", model: "s/fable" }, {
      actor: ana,
    });
    assertEquals(await asked(rt, launch), "fable", "the space's pick");

    // Back, one step at a time.
    await rt.call("tiers.pick", { space: launch, agent: "north", model: null }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku");
    await rt.call("tiers.choose", { space: launch, tier: null }, { actor: ana });
    assertEquals(await asked(rt, launch), "sonnet");
    await rt.call("tiers.choose", { tier: "expert", picks: null }, { actor: ana });
    assertEquals(await asked(rt, launch), "opus", "back to the tier as it is");
    await rt.call("tiers.choose", { tier: null }, { actor: ana });
    assertEquals(await asked(rt, launch), "haiku", "the plan's again");
    // Other spaces never saw Launch's choices.
    const other = await spaceOf(rt, "Other", ana);
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: ana });
    assertEquals(await asked(rt, other), "haiku");
  } finally {
    await rt.close();
  }
});

test("a pick keeps the tier's list behind it; with no tier naming it, its own model is", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    // The pick fails before writing anything: the tier's list takes over.
    await rt.call("tiers.pick", { agent: "north", model: "s/broken" }, { actor: ana });
    calls.length = 0;
    assertEquals(await asked(rt, launch), "opus");
    assertEquals(calls.map((c) => c.model), ["broken", "opus"]);
    // With no tier naming it, its own model is behind its pick.
    await rt.call("tiers.pick", { space: launch, agent: "east", model: "s/broken" }, {
      actor: ana,
    });
    await rt.call("tiers.choose", { tier: "everyday" }, { actor: ana });
    assertEquals(await rt.call("tiers.model", { agent: "east", space: launch }), [
      "s/broken",
      { model: "s/own-east" },
    ]);
  } finally {
    await rt.close();
  }
});

test("a pick keeps the maxTokens of what it replaces, and its effort when the model takes it", async () => {
  const deep = {
    title: "Deep",
    agents: {
      north: { model: "anthropic/claude-opus-5-5", effort: "xhigh", maxTokens: 30_000 },
    },
  };
  const rt = await start({ tiers: { ...TIERS, deep } as typeof TIERS });
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "deep" }, { actor: ana });
    const pick = async (model: unknown) => {
      await rt.call("tiers.pick", { agent: "north", model }, { actor: ana });
      await asked(rt, launch);
      return calls.at(-1);
    };
    // Haiku takes extra-high effort, as the catalog says: both carry over.
    assertEquals(await pick("anthropic/claude-haiku-5-5"), {
      model: "claude-haiku-5-5",
      effort: "xhigh",
      maxTokens: 30_000,
    });
    // Argon doesn't: it keeps the tokens, and thinks as it does by default.
    assertEquals(await pick("google/gemini-4-argon"), {
      model: "gemini-4-argon",
      maxTokens: 30_000,
    });
    // Nor is an effort given to a model the catalog doesn't know.
    assertEquals(await pick("s/plain"), { model: "plain", maxTokens: 30_000 });
    // What a pick sets itself wins.
    assertEquals(await pick({ model: "anthropic/claude-haiku-5-5", effort: "low" }), {
      model: "claude-haiku-5-5",
      effort: "low",
      maxTokens: 30_000,
    });
    // A space's pick carries over the same, and pages show it as it runs.
    await rt.call("tiers.pick", {
      space: launch,
      agent: "north",
      model: "anthropic/claude-sonnet-5-5",
    }, { actor: ana });
    assertEquals(await asked(rt, launch), "claude-sonnet-5-5");
    assertEquals(calls.at(-1), { model: "claude-sonnet-5-5", effort: "xhigh", maxTokens: 30_000 });
    const here = await rt.query<Shown>("modelChoice.offered", { space: launch }, { actor: ana });
    assertEquals(here.now.agents.north.model.effort, "xhigh");
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

test("a tier that doesn't name an agent, and agents people make, keep their own model", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    await rt.call("tiers.choose", { tier: "everyday" }, { actor: ana });
    assertEquals(await asked(rt, launch, "east"), "own-east");
    const { agent } = await rt.call<{ agent: string }>("agent.create", {
      in: launch,
      name: "Maya",
      description: "Writes",
      instructions: "I write.",
      model: "s/maya",
    }, { actor: ana });
    await rt.call("member.set", {
      space: launch,
      member: { kind: "agent", id: agent },
      role: "editor",
    }, { actor: ana });
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: ana });
    assertEquals(await asked(rt, launch, agent), "maya");
    assertEquals(await rt.call("tiers.model", { agent, space: launch }), null);
    // Nor can one be picked for it.
    assertEquals(
      await refused(
        rt.call("tiers.pick", { space: launch, agent, model: "s/opus" }, { actor: ana }),
      ),
      "invalid",
    );
  } finally {
    await rt.close();
  }
});

test("the org's owners and admins choose for it; a space's managers for the space; in person", async () => {
  const rt = await start();
  try {
    const launch = await spaceOf(rt, "Launch", bob);
    await join(rt, launch, cy, "editor", bob);
    // Bob is a member of the org: not its.
    assertEquals(
      await refused(rt.call("tiers.choose", { tier: "expert" }, { actor: bob })),
      "forbidden",
    );
    // He manages Launch: any tier there, however it costs.
    await rt.call("tiers.choose", { space: launch, tier: "expert" }, { actor: bob });
    await rt.call("tiers.pick", { space: launch, agent: "east", model: "s/fable" }, {
      actor: bob,
    });
    // Cy edits there; she doesn't choose.
    assertEquals(
      await refused(rt.call("tiers.choose", { space: launch, tier: null }, { actor: cy })),
      "forbidden",
    );
    // Ana runs the org: she reaches every space.
    await rt.call("tiers.choose", { space: launch, tier: "everyday" }, { actor: ana });
    // A key never decides; nor is a tier that isn't there, nor a model that can't be called.
    assertEquals(
      await refused(
        rt.call("tiers.choose", { tier: "expert" }, { actor: { ...ana, key: "k1" } as Actor }),
      ),
      "forbidden",
    );
    assertEquals(
      await refused(rt.call("tiers.choose", { tier: "gold" }, { actor: ana })),
      "invalid",
    );
    assertEquals(
      await refused(rt.call("tiers.pick", { agent: "north", model: "nowhere/x" }, { actor: ana })),
      "invalid",
    );
  } finally {
    await rt.close();
  }
});

test("what a page reads: the tiers on offer, what each level chose, and where each model comes from", async () => {
  const rt = await start({ prices: true });
  try {
    const launch = await spaceOf(rt, "Launch", ana);
    const secret = await spaceOf(rt, "Secret", ana);
    planTier = "everyday";
    const org = await rt.query<Shown>("modelChoice.offered", {}, { actor: bob });
    assertEquals(org.tiers.map((t) => t.name), ["everyday", "expert"]);
    assertEquals(org.tiers[1].agents.map((a) => [a.agent, a.model.id, a.model.effort]), [
      ["north", "s/opus", "medium"],
      ["east", "s/sonnet", "high"],
    ]);
    // A typical reply: 20k in, 16k of them cached, 1k out, at the org's prices (a 20% margin).
    const reply = (4_000 * 1 + 16_000 * 0.1 + 1_000 * 5) / 1e6 / 0.8;
    assert(Math.abs(org.tiers[0].price! - reply) < 1e-6, `${org.tiers[0].price} is ${reply}`);
    assertEquals(org.plan, "everyday");
    assertEquals(org.now.tier, { name: "everyday", by: "plan" });
    assertEquals(org.now.agents.north.from, { by: "plan", tier: "everyday", title: "Everyday" });
    assertEquals(org.now.agents.east.from, { by: "app" });
    assertEquals(org.now.agents.east.model.id, "s/own-east");

    await rt.call("tiers.choose", { tier: "expert" }, { actor: ana });
    await rt.call("tiers.pick", { space: launch, agent: "east", model: "s/fable" }, {
      actor: ana,
    });
    const here = await rt.query<Shown>("modelChoice.offered", { space: launch }, { actor: ana });
    assertEquals(here.org.tier, "expert");
    assertEquals(here.space, { tier: null, custom: { east: here.space!.custom.east } });
    assertEquals(here.space!.custom.east.id, "s/fable");
    assertEquals(here.now.tier, { name: "expert", by: "org" });
    assertEquals(here.now.agents.north.from, { by: "org", tier: "expert", title: "Expert" });
    assertEquals(here.now.agents.east.from, {
      by: "space",
      custom: true,
      tier: "expert",
      title: "Expert",
    });
    // One agent, as its row in the space says it: and where taking its pick back leaves it.
    const east = await rt.query<AgentNow & { without?: AgentNow }>("modelChoice.agent", {
      agent: "east",
      space: launch,
    }, { actor: ana });
    assertEquals(east.model.id, "s/fable");
    assertEquals([east.without?.model.id, east.without?.from], ["s/sonnet", {
      by: "org",
      tier: "expert",
      title: "Expert",
    }]);
    // A space is read by who reaches it.
    assertEquals(
      await refused(rt.query("modelChoice.offered", { space: secret }, { actor: bob })),
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

test("a tier naming an agent the app hasn't, or a model it can't call, stops the app starting", async () => {
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
  await assertRejects(() => bad({ south: "s/x" }), Error, `names "south"`);
  await assertRejects(() => bad({ north: "elsewhere/x" }), Error, `Tier "odd", north`);
});
