/**
 * Agents as members: each works only where it's a member. A new space
 * starts with the app's default agents, the first answering its new chats;
 * its managers make agents there, add ones they've met, choose who answers,
 * and take them out. One agent works in several spaces, changed only by who
 * manage the space it belongs to.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { type Agent, chat, type Message } from "../../agents/chat/mod.ts";
import { team } from "../../agents/team/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

/** Each agent answers with the first line of its instructions. */
const says: LlmAdapter = {
  async *generate({ instructions }) {
    yield { type: "text", text: (instructions ?? "").split("\n")[0] };
  },
};

type Here = { here: string[]; default: string[]; agents: Record<string, Agent> };

const start = async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { s: { adapter: "s" } },
      agents: {
        lead: { instructions: "I lead.", model: "s/one", default: true },
        scout: { instructions: "I scout.", model: "s/one", description: "Finds things" },
      },
    },
    adapters: { llm: { s: says } },
  });
  return await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, team, app],
  });
};

/** What answers `text` sent by `actor` in `space` (a new chat), by whom. */
async function ask(rt: Runtime, actor: Actor, space: string, text: string) {
  const { thread } = await rt.call<{ thread: string }>("chat.send", { text, in: space }, { actor });
  await rt.idle();
  const history = await rt.query<Message[]>("message.history", { thread }, { actor });
  return history.filter((m) => m.from !== actor.id).map((m) => `${m.from}: ${m.text}`);
}

const add = (rt: Runtime, space: string, agent: string, by: Actor, role = "editor") =>
  rt.call("member.set", { space, member: { kind: "agent", id: agent }, role }, { actor: by });

test("a new space has the app's default agents; only who works there answers", async () => {
  const rt = await start();
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const here = await rt.query<Here>("thread.agents", { in: launch }, { actor: ana });
    assertEquals([here.here, here.default], [["lead"], ["lead"]]);
    assertEquals(await ask(rt, ana, launch, "hello"), ["lead: I lead."]);
    // Scout doesn't work here: naming it is refused, until Ana adds it.
    assertEquals(await refused(ask(rt, ana, launch, "@scout look")), "not_here");
    await add(rt, launch, "scout", ana);
    assertEquals(await ask(rt, ana, launch, "@scout look"), ["scout: I scout."]);
    // She has Scout answer new chats here.
    await rt.call("space.agent", { space: launch, agent: "scout" }, { actor: ana });
    assertEquals(await ask(rt, ana, launch, "hello"), ["scout: I scout."]);
    // Out of Launch, it answers there no more, and Lead answers new chats again.
    await rt.call("member.remove", { space: launch, member: { kind: "agent", id: "scout" } }, {
      actor: ana,
    });
    assertEquals(await ask(rt, ana, launch, "hello"), ["lead: I lead."]);
    assertEquals(await refused(ask(rt, ana, launch, "@scout look")), "not_here");
    // A Personal space has them too.
    const { space: mine } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    assertEquals(await ask(rt, ana, mine, "hello"), ["lead: I lead."]);
  } finally {
    await rt.close();
  }
});

test("a viewer agent reads a space but doesn't answer there; a chat is with whom it names", async () => {
  const rt = await start();
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await add(rt, launch, "scout", ana, "viewer");
    // A viewer: not here to answer, nor to answer new chats.
    assertEquals(await refused(ask(rt, ana, launch, "@scout look")), "not_here");
    assertEquals(
      await refused(rt.call("space.agent", { space: launch, agent: "scout" }, { actor: ana })),
      "invalid",
    );
    assertEquals(
      (await rt.query<Here>("thread.agents", { in: launch }, { actor: ana })).here,
      ["lead"],
    );
    // An editor answers; a chat started with it is with it.
    await add(rt, launch, "scout", ana, "editor");
    await rt.call("chat.send", {
      text: "@scout look",
      in: launch,
    }, { actor: ana });
    await rt.idle();
    const [started] = await rt.query<{ agents: string[] }[]>("thread.recent", {}, { actor: ana });
    assertEquals(started.agents, ["scout"]);
    // Answering new chats, then made a viewer: Lead answers them again.
    await rt.call("space.agent", { space: launch, agent: "scout" }, { actor: ana });
    assertEquals(await ask(rt, ana, launch, "hello"), ["scout: I scout."]);
    await add(rt, launch, "scout", ana, "editor");
    assertEquals(await ask(rt, ana, launch, "hello"), ["scout: I scout."], "still, as editor");
    await add(rt, launch, "scout", ana, "viewer");
    assertEquals(await ask(rt, ana, launch, "hello"), ["lead: I lead."]);
    // What an agent is made with: models an agent talks with.
    const options = await rt.query<{ models: string[] }>("agent.options", {}, { actor: ana });
    assertEquals(options.models, ["s/one"]);
  } finally {
    await rt.close();
  }
});

test("managers make agents where they belong; others add the ones they've met", async () => {
  const rt = await start();
  try {
    const space = async (name: string, by: Actor) =>
      (await rt.call<{ space: string }>("space.create", { name }, { actor: by })).space;
    const launch = await space("Launch", ana);
    await join(rt, launch, bob, "editor", ana);

    // An editor can't make one in Launch; its manager can, then adds it.
    const make = (actor: Actor) =>
      rt.call<{ agent: string }>("agent.create", {
        in: launch,
        name: "Maya",
        description: "Writes launch copy",
        instructions: "I write.",
      }, { actor });
    assertEquals(await refused(make(bob)), "forbidden");
    const { agent } = await make(ana);
    assertEquals(agent, "maya");
    assertEquals((await make(ana)).agent, "maya-2", "another Maya is called apart");
    await add(rt, launch, agent, ana);
    assertEquals(await ask(rt, bob, launch, "@maya draft it"), ["maya: I write."]);
    const seen = await rt.query<Here>("thread.agents", { in: launch }, { actor: bob });
    assertEquals(seen.here.sort(), ["lead", "maya"]);
    assertEquals([seen.agents.maya.name, seen.agents.maya.description], [
      "Maya",
      "Writes launch copy",
    ]);

    // Only Launch's managers change it.
    assertEquals(
      await refused(
        rt.call("agent.update", { agent, instructions: "I don't." }, { actor: bob }),
      ),
      "forbidden",
    );
    await rt.call("agent.update", { agent, instructions: "I write well." }, { actor: ana });
    assertEquals(await ask(rt, bob, launch, "@maya again"), ["maya: I write well."]);

    // Bob met Maya in Launch: he adds it to his own space. Cy never did.
    const bobs = await space("Bob's", bob);
    await add(rt, bobs, agent, bob);
    assertEquals(await ask(rt, bob, bobs, "@maya hi"), ["maya: I write well."]);
    const cys = await space("Cy's", cy);
    assertEquals(await refused(add(rt, cys, agent, cy)), "invalid");
    const strange = await rt.query<Here>("thread.agents", { in: cys, names: [agent] }, {
      actor: cy,
    });
    assert(!strange.agents[agent], "Cy doesn't see Maya");
    // Whom each has met, to add: the app's agents, and Maya for Bob, not for Cy.
    const known = (actor: Actor) =>
      rt.query<Record<string, Agent>>("agent.known", {}, { actor }).then((k) => Object.keys(k));
    assertEquals((await known(bob)).sort(), ["lead", "maya", "maya-2", "scout"]);
    assertEquals((await known(cy)).sort(), ["lead", "scout"]);

    // Removed, it leaves every space it worked in.
    await rt.call("space.agent", { space: bobs, agent }, { actor: bob });
    await rt.call("agent.delete", { agent }, { actor: ana });
    await rt.idle();
    assertEquals((await rt.query<Here>("thread.agents", { in: bobs }, { actor: bob })).default, [
      "lead",
    ]);
    assertEquals(await refused(ask(rt, bob, launch, "@maya hi")), "done");
    assertEquals((await rt.query<Here>("thread.agents", { in: launch }, { actor: ana })).here, [
      "lead",
    ]);
  } finally {
    await rt.close();
  }
});
