/**
 * The org's team: the app's agents, changed or taken off by its owners and
 * admins, and agents the org makes for itself, which work in every space;
 * new spaces start with the team as it is. An agent proposes one, and it's
 * made only on its person's yes. And the app's welcome: once per person.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import models, { type LlmAdapter } from "copilotz/plugins/models";
import { type Agent, chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { ORG } from "copilotz/plugins/access/contract";
import { team } from "../team/mod.ts";
import { tiers } from "../tiers/mod.ts";
import { test } from "copilotz/testing";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** A model that plays its moves in order: text, or a tool call. */
let moves: (string | { tool: string; input: Record<string, unknown> })[] = [];
const script: LlmAdapter = {
  async *generate() {
    const move = moves.shift() ?? "ok";
    if (typeof move === "string") yield { type: "text", text: move };
    else {yield {
        type: "tool_call",
        call: { id: `c${moves.length}`, name: move.tool, input: move.input },
      };}
  },
};

async function start(): Promise<Runtime> {
  moves = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      team,
      tiers,
      definePlugin({
        name: "app",
        adapters: { llm: { s: script } },
        resources: {
          shared: { thread: {}, message: {} },
          provider: { s: { adapter: "s", apiKey: "k" } },
          agents: {
            north: {
              instructions: "I lead.",
              model: "s/north",
              default: true,
              tools: ["propose_agent"],
            },
            east: { instructions: "I build.", model: "s/east", default: true },
          },
          tiers: { everyday: { title: "Everyday", agents: { north: "s/n", east: "s/e" } } },
        },
      }),
    ],
  });
  await rt.call("org.join", { person: "ana", role: "owner" });
  await rt.call("org.join", { person: "bob" });
  return rt;
}

const seated = async (rt: Runtime, space: string) =>
  (await rt.call<{ agents: string[] }>("space.roster", { space })).agents.sort();

const named = async (rt: Runtime, names: string[]) =>
  await rt.call<Record<string, Agent>>("agent.define", { names });

test("the org's team: changed, taken off, put back; its own agents work in every space", async () => {
  const rt = await start();
  try {
    const launch = (await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    })).space;
    assertEquals(await seated(rt, launch), ["east", "north"]);

    // One of the app's, changed: the org's version, over the app's; its model still the tiers'.
    await rt.call("agent.update", { agent: "north", description: "Runs our week." }, {
      actor: ana,
    });
    assertEquals((await named(rt, ["north"])).north.description, "Runs our week.");
    assertEquals((await named(rt, ["north"])).north.model, undefined);

    // Taken off: it leaves every space and joins no new one; back, it's everywhere again.
    await rt.call("agent.delete", { agent: "east" }, { actor: ana });
    assertEquals(await seated(rt, launch), ["north"]);
    const later = (await rt.call<{ space: string }>("space.create", { name: "Later" }, {
      actor: ana,
    })).space;
    assertEquals(await seated(rt, later), ["north"]);
    await rt.call("agent.restore", { agent: "east" }, { actor: ana });
    assertEquals([await seated(rt, launch), await seated(rt, later)], [
      ["east", "north"],
      ["east", "north"],
    ]);

    // The org's own: in every space now, and in every new one.
    const { agent } = await rt.call<{ agent: string }>("agent.create", {
      name: "Ledger",
      in: ORG,
      like: "east",
    }, { actor: ana });
    assertEquals(await seated(rt, launch), ["east", "ledger", "north"]);
    const newest = (await rt.call<{ space: string }>("space.create", { name: "Newest" }, {
      actor: ana,
    })).space;
    assertEquals(await seated(rt, newest), ["east", "ledger", "north"]);
    assertEquals(await rt.call("tiers.model", { agent: "east", space: newest }), "s/e");

    // Back as the app has it.
    await rt.call("agent.reset", { agent: "north" }, { actor: ana });
    assertEquals((await named(rt, ["north"])).north, undefined, "nothing of the org's left");

    // Only who runs the org changes its team. (Each call made as it's awaited: one refused while
    // another was still awaited would go unhandled.)
    for (
      const call of [
        () => rt.call("agent.update", { agent: "north", description: "x" }, { actor: bob }),
        () => rt.call("agent.delete", { agent: "north" }, { actor: bob }),
        () => rt.call("agent.create", { name: "Mine", in: ORG }, { actor: bob }),
        () => rt.call("agent.delete", { agent }, { actor: bob }),
      ]
    ) {
      assertEquals(
        await call().then(() => "done", (e) => (e as { code?: string }).code),
        "forbidden",
      );
    }
  } finally {
    await rt.close();
  }
});

test("an agent proposes an agent; it's made only on its person's yes", async () => {
  const rt = await start();
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    moves = [
      {
        tool: "propose_agent",
        input: {
          name: "Ledger",
          icon: "📊",
          description: "Keeps the numbers straight.",
          instructions: "You are Ledger.",
          kind: "east",
        },
      },
      "Asked.",
      "Made it.",
    ];
    await rt.call("chat.send", { in: space, text: "We need someone for the numbers." }, {
      actor: ana,
    });
    await rt.idle();
    const waiting = await rt.query<{ _id: string; work: string }[]>("approval.pending", {}, {
      actor: ana,
    });
    assertEquals(waiting.length > 0, true, "the person is asked");
    assertEquals((await named(rt, ["ledger"])).ledger, undefined, "nothing made before the yes");
    await rt.call("chat.approve", { approval: waiting[0]._id, answer: "once" }, { actor: ana });
    await rt.idle();
    assertEquals((await named(rt, ["ledger"])).ledger?.like, "east");
    assertEquals((await seated(rt, space)).includes("ledger"), true);
  } finally {
    await rt.close();
  }
});

test("the app's welcome: each person once, and again when asked", async () => {
  const rt = await start();
  try {
    const seen = (actor: Actor) =>
      rt.query<{ seen: boolean }>("welcome.seen", {}, { actor }).then((s) => s.seen);
    assertEquals([await seen(ana), await seen(bob)], [false, false]);
    await rt.call("chat.welcomed", {}, { actor: ana });
    await rt.call("chat.welcomed", {}, { actor: ana });
    assertEquals([await seen(ana), await seen(bob)], [true, false]);
    // In person only: an agent working for someone doesn't close it for them.
    const north: Actor = { kind: "agent", id: "north", for: bob };
    assertEquals(
      await rt.call("chat.welcomed", {}, { actor: north }).then(() => "done", () => "refused"),
      "refused",
    );
  } finally {
    await rt.close();
  }
});

test("an agent's instructions are as long as the app lets them be: 100,000 characters unless it says", async () => {
  const rt = await start();
  try {
    const long = "Say it well. ".repeat(2_000); // 26,000 characters: past the old 20,000.
    await rt.call("agent.update", { agent: "north", instructions: long }, { actor: ana });
    assertEquals((await named(rt, ["north"])).north.instructions, long);
    const failed = await rt.call("agent.update", {
      agent: "north",
      instructions: "x".repeat(100_001),
    }, { actor: ana }).then(() => undefined, (e) => e as { code?: string; detail?: unknown });
    assertEquals([failed?.code, failed?.detail], ["invalid", { field: "instructions" }]);
  } finally {
    await rt.close();
  }
  // An app's own limit.
  const small = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      team,
      definePlugin({
        name: "app",
        adapters: { llm: { s: script } },
        resources: {
          team: { instructionsLimit: 100 },
          provider: { s: { adapter: "s", apiKey: "k" } },
          agents: { north: { instructions: "I lead.", model: "s/north", default: true } },
        },
      }),
    ],
  });
  try {
    await small.call("org.join", { person: "ana", role: "owner" });
    const failed = await small.call("agent.update", {
      agent: "north",
      instructions: "x".repeat(101),
    }, { actor: ana }).then(() => undefined, (e) => e as { code?: string });
    assertEquals(failed?.code, "invalid");
  } finally {
    await small.close();
  }
});
