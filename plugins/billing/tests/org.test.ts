/**
 * Usage across an org: its owners and admins (and platform staff) see
 * everyone's totals and activity (`usage.org`, `usage.activity`), after
 * asking the org who's calling (`org.me`); anyone else sees their own, and
 * no filter of theirs reaches anyone else's. An app without org roles has
 * nobody who sees everyone's. Totals group and filter by category (agents,
 * computers, apps) and name what they're grouped by as the caller reads
 * it; activity shows turns, computers' sessions, apps' days and
 * conversations' upkeep, not ledger records.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import usage, { type ActivityItem } from "../usage/mod.ts";
import { test } from "../../../testing/mod.ts";

type Totals = {
  key: Record<string, string>;
  uses: number;
  price: number;
  quantities: Record<string, number>;
};
type Activity = { items: ActivityItem[]; more: boolean; all: boolean; costs: boolean };

/** An org whose roles are these: `org.me`, as the spaces plugin answers it. */
const org = (roles: Record<string, string>) =>
  definePlugin({
    name: "org",
    actions: {
      "org.me": defineAction({
        input: { type: "object" },
        allow: (actor) => actor.kind === "person",
        run: (ctx) => ({ role: roles[ctx.actor!.id] ?? null, staff: ctx.actor?.staff === true }),
      }),
    },
  });

const person = (id: string, staff = false): Actor => ({
  kind: "person",
  id,
  ...(staff ? { staff: true } : {}),
});

async function started(roles?: Record<string, string>) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, usage, ...(roles ? [org(roles)] : [])],
  });
  const uses = [
    ["ana", "assistant", "openai/gpt-5.4-mini", 1000],
    ["ana", "researcher", "openai/gpt-5.4-mini", 2000],
    ["bob", "assistant", "openai/gpt-5.4-mini", 4000],
    ["carol", "assistant", "openai/gpt-5.4-mini", 8000],
  ] as const;
  for (const [n, [who, agent, subject, input]] of uses.entries()) {
    await runtime.call("usage.record", {
      // A second apart, so the latest are in a known order.
      at: new Date(Date.now() - (uses.length - n) * 1000).toISOString(),
      meter: "llm",
      subject,
      catalog: subject,
      quantities: { input, output: 10 },
      tags: { person: who, agent },
    });
  }
  return runtime;
}

const byPerson = (totals: Totals[]) =>
  Object.fromEntries(totals.map((t) => [t.key["tags.person"], t.quantities.input]));

test("the org's owners and admins see everyone's totals; members their own", async () => {
  const runtime = await started({ ana: "owner", bob: "admin", carol: "member" });
  try {
    for (const who of ["ana", "bob"]) {
      const { totals, all } = await runtime.call<{ totals: Totals[]; all: boolean }>(
        "usage.org",
        { by: ["tags.person"] },
        { actor: person(who) },
      );
      assertEquals(all, true);
      assertEquals(byPerson(totals), { ana: 3000, bob: 4000, carol: 8000 });
    }
    const carol = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.person"] },
      { actor: person("carol") },
    );
    assertEquals(carol.all, false);
    assertEquals(byPerson(carol.totals), { carol: 8000 });
  } finally {
    await runtime.close();
  }
});

test("a member's filter never reaches anyone else's usage", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    for (
      const filter of [
        { "tags.person": "ana" },
        { $or: [{ "tags.person": "ana" }, { "tags.person": "bob" }] },
        { "tags.agent": "researcher" },
      ]
    ) {
      const { totals } = await runtime.call<{ totals: Totals[] }>(
        "usage.org",
        { filter, by: ["tags.person"] },
        { actor: person("carol") },
      );
      assertEquals(Object.keys(byPerson(totals)).filter((p) => p !== "carol"), []);
      const { items } = await runtime.call<Activity>(
        "usage.activity",
        { filter },
        { actor: person("carol") },
      );
      assertEquals(items.filter((i) => i.tags.person !== "carol"), []);
    }
  } finally {
    await runtime.close();
  }
});

test("platform staff see everyone's; activity, newest first, by the same rule", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    const staff = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.agent"] },
      { actor: person("sam", true) },
    );
    assertEquals(staff.all, true);
    assertEquals(
      Object.fromEntries(staff.totals.map((t) => [t.key["tags.agent"], t.uses])),
      { assistant: 3, researcher: 1 },
    );
    const everyone = await runtime.call<Activity>(
      "usage.activity",
      { limit: 3 },
      { actor: person("ana") },
    );
    assertEquals(everyone.all, true);
    assertEquals(everyone.items.map((i) => i.tags.person), ["carol", "bob", "ana"]);
    assertEquals(everyone.more, true);
    const own = await runtime.call<Activity>(
      "usage.activity",
      { filter: { "tags.person": "ana" } },
      { actor: person("carol") },
    );
    assertEquals(own.all, false);
    assertEquals(own.items.map((i) => i.tags.person), ["carol"]);
  } finally {
    await runtime.close();
  }
});

test("without org roles, everyone sees their own; outside callers are refused", async () => {
  const runtime = await started();
  try {
    const { totals, all } = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.person"] },
      { actor: person("ana") },
    );
    assertEquals(all, false);
    assertEquals(byPerson(totals), { ana: 3000 });
    for (const action of ["usage.org", "usage.activity"]) {
      await assertRejects(() =>
        runtime.call(action, {}, { actor: { kind: "key", id: "k1" } as Actor })
      );
    }
  } finally {
    await runtime.close();
  }
});

test("everyone sees prices; what it cost, and so the margin, only platform staff", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    type Seen = { totals: Record<string, unknown>[]; costs: boolean };
    for (const [who, sees] of [[person("ana"), false], [person("carol"), false]] as const) {
      const org = await runtime.call<Seen>("usage.org", {}, { actor: who });
      assertEquals(org.costs, sees);
      assertEquals([org.totals[0].cost, org.totals[0].costs], [undefined, undefined]);
      assert((org.totals[0].price as number) > 0, "the price");
      const activity = await runtime.call<Activity>("usage.activity", {}, { actor: who });
      assertEquals(activity.costs, false);
      assert(activity.items.every((i) => i.cost === undefined && i.price > 0));
      assert(activity.items.every((i) => i.saved.cost === undefined));
    }
    const staff = await runtime.call<Seen>("usage.org", {}, { actor: person("sam", true) });
    assertEquals(staff.costs, true);
    // No price book: the price is the cost.
    assertEquals(staff.totals[0].price, staff.totals[0].cost);
    const activity = await runtime.call<Activity>("usage.activity", {}, {
      actor: person("sam", true),
    });
    assert(activity.items.every((i) => i.cost === i.price));
  } finally {
    await runtime.close();
  }
});

/**
 * Uses of every kind, in Research and Launch, on Nov 2, 2026 (UTC). The
 * plugin holding spaces names them for usage (`usageNames`), unless `named`
 * is false.
 */
async function kinds({ named = true } = {}) {
  const spaces = defineCollection({
    schema: { type: "object", properties: { name: { type: "string" }, owner: { type: "string" } } },
  });
  const app = definePlugin({
    name: "app",
    collections: { space: spaces },
    resources: {
      cost: {
        "script/*": { input: 1, output: 2 },
        "cloud/*": { seconds: 0.001, per: 1 },
        "app/*": { requests: 0.0001, minutes: 0.01, per: 1 },
        "tool/*": { calls: 0.001, per: 1 },
      },
      ...(named
        ? {
          usageNames: {
            space: { tag: "tags.space", collection: "space", field: "name", owner: "owner" },
          },
        }
        : {}),
    },
    // Carol reaches only Launch: Research's name isn't hers to read.
    guard: (actor, { collection }) =>
      collection === "space" && actor.id === "carol" ? { _id: "launch" } : true,
    actions: {
      "seed.spaces": defineAction({
        input: { type: "object" },
        run: (ctx) =>
          ctx.db.collection("space").insertMany([
            { _id: "research", name: "Research" },
            { _id: "launch", name: "Launch" },
            { _id: "p-ana", name: "Personal", owner: "ana" },
          ]),
      }),
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, usage, org({ ana: "owner", carol: "member" }), app],
  });
  await runtime.call("seed.spaces", {});
  const at = (time: string) => `2026-11-02T${time}.000Z`;
  const record = (use: Record<string, unknown>) => runtime.call("usage.record", use);
  const llm = (time: string, subject: string, input: number, tags: Record<string, string>) =>
    record({ meter: "llm", subject, quantities: { input, output: 10 }, tags, at: at(time) });
  const turn = { thread: "t1", agent: "north", turn: "r1", person: "ana", space: "research" };
  // A turn of two calls (the second on the main model, charged more), then its upkeep.
  await llm("10:00:01", "script/small", 100, turn);
  await llm("10:00:05", "script/big", 5000, turn);
  await llm("10:00:09", "script/small", 300, {
    thread: "t1",
    purpose: "history",
    person: "ana",
    space: "research",
  });
  await llm("10:00:10", "script/small", 200, {
    thread: "t1",
    purpose: "memory",
    person: "ana",
    space: "research",
  });
  // A computer's session: three minutes awake, from its wake at 11:00.
  for (const time of ["11:01:00", "11:02:00", "11:03:00"]) {
    await record({
      meter: "computer",
      subject: "cloud/small",
      quantities: { seconds: 60 },
      tags: {
        computer: "c1",
        person: "carol",
        space: "launch",
        session: at("11:00:00"),
      },
      at: at(time),
    });
  }
  // Minutes from before sessions were recorded: that computer's day.
  await record({
    meter: "computer",
    subject: "cloud/small",
    quantities: { seconds: 120 },
    tags: { computer: "c1", person: "carol" },
    at: at("08:00:00"),
  });
  // An app's day: a build, then what it ran.
  await record({
    meter: "app",
    subject: "app/build",
    quantities: { minutes: 2 },
    tags: { app: "a1", person: "ana", space: "launch" },
    at: at("12:00:00"),
  });
  await record({
    meter: "app",
    subject: "app/run",
    quantities: { requests: 500, vcpuSeconds: 30 },
    tags: { app: "a1", person: "ana", space: "launch" },
    at: at("13:00:00"),
  });
  // An app's own meter.
  await record({
    meter: "tool",
    subject: "tool/search",
    quantities: { calls: 3 },
    tags: { person: "ana" },
    at: at("14:00:00"),
  });
  return runtime;
}

test("totals by category (agents, computers, apps, an app's own), and filtered by it", async () => {
  const runtime = await kinds();
  try {
    const ana = { actor: person("ana") };
    const { totals } = await runtime.call<{ totals: Totals[] }>(
      "usage.org",
      { by: ["category"] },
      ana,
    );
    assertEquals(
      Object.fromEntries(totals.map((t) => [t.key.category, t.uses])),
      { agents: 4, computers: 4, apps: 2, tool: 1 },
    );
    // Its meter too, when asked.
    const both = await runtime.call<{ totals: Totals[] }>(
      "usage.org",
      { by: ["category", "meter"] },
      ana,
    );
    assertEquals(
      both.totals.map((t) => `${t.key.category}/${t.key.meter}`).sort(),
      ["agents/llm", "apps/app", "computers/computer", "tool/tool"],
    );
    const computers = await runtime.call<{ totals: Totals[] }>(
      "usage.org",
      { filter: { category: "computers" }, by: ["subject"] },
      ana,
    );
    assertEquals(computers.totals.map((t) => [t.key.subject, t.quantities.seconds]), [
      ["cloud/small", 300],
    ]);
    const some = await runtime.call<{ totals: Totals[] }>(
      "usage.org",
      { filter: { category: { $in: ["apps", "tool"] } }, by: ["category"] },
      ana,
    );
    assertEquals(some.totals.map((t) => t.key.category).sort(), ["apps", "tool"]);
    await assertRejects(() =>
      runtime.call("usage.org", { filter: { category: "agents", meter: { $in: ["llm"] } } }, ana)
    );
  } finally {
    await runtime.close();
  }
});

test("totals name what they're grouped by, as the caller reads it", async () => {
  const runtime = await kinds();
  try {
    type Named = { totals: Totals[]; names: Record<string, Record<string, unknown>> };
    const ana = await runtime.call<Named>("usage.org", { by: ["tags.space"] }, {
      actor: person("ana"),
    });
    assertEquals(
      Object.fromEntries(ana.totals.map((t) => [t.key["tags.space"] ?? "none", t.uses])),
      { research: 4, launch: 5, none: 2 },
    );
    assertEquals(ana.names["tags.space"], {
      research: { name: "Research" },
      launch: { name: "Launch" },
    });
    // Carol sees her own, and names only what she reaches.
    const carol = await runtime.call<Named>("usage.org", { by: ["tags.space"] }, {
      actor: person("carol"),
    });
    assertEquals(carol.names["tags.space"], { launch: { name: "Launch" } });
  } finally {
    await runtime.close();
  }
});

test("a tag nobody names stays an id; a naming that says too little stops the app", async () => {
  const runtime = await kinds({ named: false });
  try {
    const { names } = await runtime.call<{ names: Record<string, unknown> }>(
      "usage.org",
      { by: ["tags.space"] },
      { actor: person("ana") },
    );
    assertEquals(names, {});
  } finally {
    await runtime.close();
  }
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [
          models,
          usage,
          definePlugin({
            name: "app",
            resources: { usageNames: { space: { tag: "tags.space", collection: "space" } } },
          }),
        ],
      }),
    Error,
    'usageNames "space" needs a tag, a collection and a field',
  );
});

test("activity: a turn and its calls, a conversation's upkeep, a session, an app's day", async () => {
  const runtime = await kinds();
  try {
    const { items, names, more } = await runtime.call<
      Activity & { names: Record<string, Record<string, { name: string }>> }
    >("usage.activity", { filter: { at: { $gte: "2026-11-01", $lt: "2026-12-01" } } }, {
      actor: person("ana"),
    });
    assertEquals(more, false);
    assertEquals(
      items.map((i) => [i.kind, i.subject ?? i.purposes?.join() ?? i.tags.app]),
      [
        ["other", "tool/search"],
        ["app", "a1"],
        ["session", "cloud/small"],
        ["model", "history,memory"],
        ["turn", "script/big"],
        ["computer", "cloud/small"],
      ],
    );
    const [, day, session, upkeep, turn, old] = items;
    // The conversation's upkeep: its summaries and memory notes, one item, in its space.
    assertEquals([upkeep.uses, upkeep.tags.thread, upkeep.tags.space, upkeep.tags.agent], [
      2,
      "t1",
      "research",
      undefined,
    ]);
    // The app's day: its build and what it ran, together.
    assertEquals([day.uses, day.quantities.minutes, day.quantities.requests], [2, 2, 500]);
    assertEquals(day.tags.space, "launch");
    // The session: from its wake, three minutes, one item.
    assertEquals([session.tags.session, session.quantities.seconds, session.uses], [
      "2026-11-02T11:00:00.000Z",
      180,
      3,
    ]);
    // The turn: its agent and conversation, its main model, and its calls, oldest first.
    assertEquals([turn.tags.agent, turn.tags.thread, turn.tags.space, turn.tags.person], [
      "north",
      "t1",
      "research",
      "ana",
    ]);
    assertEquals(turn.calls?.map((c) => c.subject), ["script/small", "script/big"]);
    assertEquals(turn.quantities.input, 5100);
    assert(turn.price > 0 && turn.calls!.every((c) => c.price! > 0));
    // Minutes from before sessions: that computer's day.
    assertEquals([old.tags.computer, old.quantities.seconds, old.tags.session], [
      "c1",
      120,
      undefined,
    ]);
    assertEquals(names["tags.space"]?.research?.name, "Research");

    // Filtered like the rest of the page: agents only, then a space.
    const agents = await runtime.call<Activity>(
      "usage.activity",
      { filter: { category: "agents" } },
      { actor: person("ana") },
    );
    assertEquals([...new Set(agents.items.map((i) => i.kind))].sort(), ["model", "turn"]);
    const launch = await runtime.call<Activity>(
      "usage.activity",
      { filter: { "tags.space": "launch" } },
      { actor: person("ana") },
    );
    assertEquals(launch.items.map((i) => i.kind), ["app", "session"]);
    // A member: their own computer's, nothing of the turn's.
    const carol = await runtime.call<Activity>("usage.activity", {}, { actor: person("carol") });
    assertEquals(carol.items.map((i) => i.kind), ["session", "computer"]);
  } finally {
    await runtime.close();
  }
});
