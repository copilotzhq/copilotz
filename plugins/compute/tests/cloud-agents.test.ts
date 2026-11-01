/**
 * Agents manage cloud computers, in a real turn, for the person they work for:
 * they list and make them with the same rules a person has, nobody asked; they
 * add, remove, rename and choose one; destroying asks that person, every time;
 * and a person's own machine isn't theirs to manage.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin, manualClock } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { cloud, type CloudComputer, cloudPool, computers, type Desk } from "../mod.ts";
import type { Approval } from "../computers/collections/approval.ts";
import { test } from "../../../testing/mod.ts";
import { fakeCloud } from "./fake-cloud.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What each tool said, what the model was offered last, and all it was told. */
let said: unknown[] = [];
let offered: string[] = [];
let told = "";

/** `call <tool> <json>` calls it; after a tool, it says it's done. */
const script: LlmAdapter = {
  async *generate({ messages, tools = [], instructions }) {
    offered = tools.map((t) => t.name);
    told = messages.map(text).join("\n") + instructions;
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      said.push(text(last));
      yield { type: "text", text: "done" };
      return;
    }
    const heard = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const call = heard.match(/call (\w+) ?(\{.*\})?/s);
    if (call) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: call[1], input: JSON.parse(call[2] ?? "{}") },
      };
    } else yield { type: "text", text: "ok" };
  },
};

const TOOLS = ["terminal", "list_computers", "create_computer", "manage_computer"];

type Rt = Awaited<ReturnType<typeof createRuntime>>;

async function setup(
  fn: (rt: Rt, world: ReturnType<typeof fakeCloud>, space: string) => Promise<void>,
  settings: Record<string, unknown> = {},
) {
  said = [];
  const topic = `cloud-agents.${crypto.randomUUID()}`;
  const world = fakeCloud(topic);
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      computers,
      cloud,
      cloudPool,
      definePlugin({
        name: "app",
        adapters: {
          llm: { s: script },
          cloudHost: { fake: world.host as Record<string, unknown> },
        },
        resources: {
          provider: { s: { adapter: "s" } },
          cloud: {
            host: "fake",
            placements: [{ project: "test", zone: "test-a" }],
            pool: { floor: [], max: 10 },
            ...settings,
          },
          computers: { approve: [] },
          shared: { thread: {}, message: {} },
          agents: {
            assistant: { instructions: "Hi.", model: "s/a", default: true, tools: TOOLS },
            plain: { instructions: "Hi.", model: "s/p", tools: ["terminal"] },
          },
        },
      }),
    ],
    transports: [{ type: "in-process", config: { topic } }],
    clock: manualClock(Date.now()),
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    await fn(rt, world, space);
  } finally {
    await world.close();
    await rt.close();
  }
}

/** The chat a turn ran in, for the next to go on in (a yes counts in its own chat). */
let asked_in = "";

/** A turn that calls one tool, in a new chat unless told; what it said. */
async function use(
  rt: Rt,
  space: string,
  tool: string,
  input: unknown = {},
  actor = ana,
  thread?: string,
) {
  const where = thread ? { thread } : { in: space };
  const sent = await rt.call<{ thread: string }>("chat.send", {
    ...where,
    text: `call ${tool} ${JSON.stringify(input)}`,
  }, { actor });
  asked_in = sent.thread;
  await rt.idle();
  const last = said.at(-1) as string;
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

const desksIn = async (rt: Rt, space: string, actor = ana) =>
  await rt.query<Desk[]>("desk.here", { in: space }, { actor });
const records = (rt: Rt) => rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana });

test("an agent makes a cloud computer for its person, unasked, and works on it", async () => {
  await setup(async (rt, world, space) => {
    // With no computer, it's told it can make one.
    await use(rt, space, "list_computers");
    assertStringIncludes(told, "you make a cloud computer with create_computer");
    const listed = await use(rt, space, "list_computers");
    assertEquals(listed.here, []);
    assertEquals(listed.can_create, true);
    assertEquals(listed.sizes[0].id, "small");

    const made = await use(rt, space, "create_computer");
    assertEquals([made.name, made.size], ["Small cloud computer", "small"]);
    const [record] = await records(rt);
    assertEquals([record._id, record.owner, record.state], [made.computer, "ana", "asleep"]);
    assert(world.disks.has(record.disk), "its disk");
    assertEquals((await desksIn(rt, space)).map((d) => d.computer), [made.computer]);
    assertEquals(await rt.query("approval.pending", {}, { actor: ana }), []);

    // Its own work wakes it.
    const ran = await use(rt, space, "terminal", { stdin: "ls" });
    assertEquals(ran.stdout, "ran ls");
    assertEquals((await records(rt))[0].state, "awake");

    // The same name again in this space is told, not made twice.
    assertStringIncludes(await use(rt, space, "create_computer"), "already has a computer called");
    assertEquals((await records(rt)).length, 1);
    // A second, named, isn't the default.
    const second = await use(rt, space, "create_computer", { name: "Build box" });
    assertStringIncludes(second.note, 'give computer "Build box"');
  });
});

test("the rules are the person's: a member can't where only admins make them, can where members do", async () => {
  const shared = async (rt: Rt) => {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    return space;
  };
  await setup(async (rt) => {
    const space = await shared(rt);
    const listed = await use(rt, space, "list_computers", {}, bob);
    assertEquals([listed.can_create, listed.why_not], [false, "admins"]);
    assertStringIncludes(
      await use(rt, space, "create_computer", {}, bob),
      "Only the org's owners and admins",
    );
    assertEquals(await desksIn(rt, space), []);
  });
  await setup(async (rt) => {
    const space = await shared(rt);
    const made = await use(rt, space, "create_computer", {}, bob);
    const [desk] = await desksIn(rt, space);
    // Bob's, in the space, and so Ana sees it there too.
    assertEquals([desk.computer, desk.owner], [made.computer, "bob"]);
  }, { create: "members" });
});

test("an agent adds, renames, chooses and removes a computer; it and its files stay", async () => {
  await setup(async (rt, world, space) => {
    const { space: other } = await rt.call<{ space: string }>("space.create", { name: "Other" }, {
      actor: ana,
    });
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
      in: other,
      name: "Elsewhere",
    }, { actor: ana });
    const listed = await use(rt, space, "list_computers");
    assertEquals(listed.yours_elsewhere[0].name, "Elsewhere");

    const manage = (input: Record<string, unknown>) => use(rt, space, "manage_computer", input);
    assertStringIncludes(
      await manage({ computer: "Elsewhere", action: "remove" }),
      "isn't in this",
    );
    assertStringIncludes(
      await manage({ computer: "Elsewhere", action: "add" }),
      "is in this space",
    );
    assertStringIncludes(await manage({ computer: id, action: "add" }), "already");
    assertStringIncludes(
      await manage({ computer: "Elsewhere", action: "rename", name: "Renamed" }),
      '"Renamed"',
    );
    const made = await use(rt, space, "create_computer", { name: "Second" });
    assertStringIncludes(await manage({ computer: "Second", action: "default" }), "use");
    const desks = await desksIn(rt, space);
    assertEquals(desks.find((d) => d.default)?.computer, made.computer);

    assertStringIncludes(
      await manage({ computer: "Renamed", action: "remove" }),
      "It and its files",
    );
    assert(!(await desksIn(rt, space)).some((d) => d.computer === id), "out of this space");
    assert(world.disks.has(`cz-d-${id}`), "its disk stays");
    assert((await records(rt)).some((r) => r._id === id), "it stays");
  });
});

test("destroying asks its person each time, and only a yes this once does it", async () => {
  await setup(async (rt, world, space) => {
    const made = await use(rt, space, "create_computer", { name: "Doomed" });
    const destroy = { computer: "Doomed", action: "destroy" };
    assertStringIncludes(
      await use(rt, space, "manage_computer", destroy),
      "yes to destroy their computer for good, with its files: Doomed",
    );
    assert((await records(rt)).length === 1, "still there");
    const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
    assertEquals([asked.work, asked.detail, asked.status], ["destroy", "Doomed", "pending"]);

    await assertRejects(
      () => rt.call("computer.approve", { approval: asked._id, answer: "always" }, { actor: ana }),
      Error,
      "asked every time",
    );
    await rt.call("computer.approve", { approval: asked._id, answer: "once" }, { actor: ana });
    await rt.idle();
    assertStringIncludes(
      await use(rt, space, "manage_computer", destroy, ana, asked_in),
      "is gone",
    );
    assertEquals(await records(rt), []);
    assert(!world.disks.has(`cz-d-${made.computer}`), "its disk with it");
    assertEquals(await desksIn(rt, space), []);
  });
});

test("destroying isn't for a member who doesn't own it, and they aren't asked", async () => {
  await setup(async (rt) => {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Team" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    await use(rt, space, "create_computer", { name: "Ana's" });
    assertStringIncludes(
      await use(rt, space, "manage_computer", { computer: "Ana's", action: "destroy" }, bob),
      "Only its owner",
    );
    assertEquals((await records(rt)).length, 1);
  });
});

test("a person's own machine isn't an agent's to manage", async () => {
  await setup(async (rt, _world, space) => {
    const { id } = await rt.call<{ id: string }>("computer.provision", {
      owner: "ana",
      name: "Laptop",
      in: space,
    });
    for (const action of ["remove", "rename", "default", "destroy"]) {
      assertStringIncludes(
        await use(rt, space, "manage_computer", { computer: "Laptop", action, name: "x" }),
        "own machine",
      );
    }
    assertEquals((await desksIn(rt, space)).map((d) => d.computer), [id]);
  });
});

test("an agent without the tool isn't told it can make one; one who can't write isn't offered it", async () => {
  await setup(async (rt, _world, space) => {
    await rt.call("member.set", {
      space,
      member: { kind: "agent", id: "plain" },
      role: "editor",
    }, { actor: ana });
    await rt.call("chat.send", { in: space, text: "@plain hello" }, { actor: ana });
    await rt.idle();
    assert(!told.includes("create_computer"), "plain isn't told");

    const { space: team } = await rt.call<{ space: string }>("space.create", { name: "Team" }, {
      actor: ana,
    });
    await use(rt, team, "list_computers");
    assert(offered.includes("create_computer"), "where its person may write");
  });
});
