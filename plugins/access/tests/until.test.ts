/**
 * A membership until a time (`member.set`'s `until`): reach ignores it once
 * it's past, and a timer removes it then, on the record as the system's. Set
 * again without one, it lasts; a space's last manager is never given an end.
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  manualClock,
  people,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

const text = { type: "string" } as const;
const HOUR = 3_600_000;

/** What `found` finds, once it does: a timer's call runs on its own. */
async function eventually<T>(found: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await found();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
}

const app = definePlugin({
  name: "until-test",
  requires: ["spaces"],
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
      allow: people,
      run: (ctx, input) => ctx.db.collection("note").insertOne(input),
    }),
    "note.list": defineAction({
      input: { type: "object" },
      allow: people,
      run: async (ctx) =>
        (await ctx.db.collection<{ text: string }>("note").find({})).map((n) => n.text).sort(),
    }),
    // A membership as an older app kept it, already past its end, with no timer.
    "test.past": defineAction({
      input: { type: "object", properties: { space: text }, required: ["space"] },
      run: (ctx, input) =>
        ctx.as().db.collection("member").replaceOne({ _id: `${input.space}|person:bob` }, {
          member: "person:bob",
          space: input.space,
          role: "editor",
          until: new Date(Date.now() - 1000).toISOString(),
        }),
    }),
  },
  resources: { shared: { note: {} } },
});

type Setup = {
  rt: Runtime;
  store: ReturnType<typeof memoryStore>;
  team: string;
  clock: ReturnType<typeof manualClock>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const clock = manualClock(Date.now());
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [...access, app], clock });
  try {
    const { space: team } = await rt.call<{ space: string }>("space.create", { name: "Team" }, {
      actor: ana,
    });
    await rt.call("note.add", { in: team, text: "plan" }, { actor: ana });
    await join(rt, team, bob, "editor", ana);
    await fn({ rt, store, team, clock });
  } finally {
    await rt.close();
  }
}

test("a membership until a time: reached until then, removed by its timer", async () => {
  await setup(async ({ rt, store, team, clock }) => {
    const until = new Date(Date.now() + HOUR).toISOString();
    await rt.call("member.set", {
      space: team,
      member: { kind: "person", id: "bob" },
      role: "viewer",
      until,
    }, { actor: ana });
    assertEquals(await rt.call("note.list", {}, { actor: bob }), ["plan"]);
    clock.set(until);
    // Gone, on the record as the system's (its timer's), not the manager's.
    const gone = await eventually(async () =>
      (await store.events(0)).find((e) =>
        e.type === "member.deleted" && e.data._id === `${team}|person:bob`
      )
    );
    assertEquals(gone.actor?.kind ?? "system", "system");
    assertEquals(await rt.call("note.list", {}, { actor: bob }), []);
  });
});

test("set again without an end, it lasts; a timer for an end it no longer has leaves it", async () => {
  await setup(async ({ rt, store, team, clock }) => {
    const until = new Date(Date.now() + HOUR).toISOString();
    const bobs = { space: team, member: { kind: "person", id: "bob" }, role: "editor" };
    await rt.call("member.set", { ...bobs, until }, { actor: ana });
    assertEquals((await store.find("sys.timers")).length, 1);
    await rt.call("member.set", bobs, { actor: ana });
    assertEquals(await store.find("sys.timers"), []);
    clock.advance(2 * HOUR);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(await rt.call("note.list", {}, { actor: bob }), ["plan"]);
    // Called for an end it no longer has (re-seated some other way), it leaves it.
    const ended = await rt.call("member.expire", { space: team, member: "person:bob", until });
    assertEquals(ended, { ended: false });
    assertEquals(await rt.call("note.list", {}, { actor: bob }), ["plan"]);
  });
});

test("one already past is no membership, timer or not", async () => {
  await setup(async ({ rt, team }) => {
    assertEquals(await rt.call("note.list", {}, { actor: bob }), ["plan"]);
    await rt.call("test.past", { space: team });
    assertEquals(await rt.call("note.list", {}, { actor: bob }), []);
    assertEquals(
      await code(rt.call("note.add", { in: team, text: "x" }, { actor: bob })),
      "forbidden",
    );
  });
});

test("an end is a time to come, and never the last manager's", async () => {
  await setup(async ({ rt, team }) => {
    const set = (member: Actor, role: string, until: string) =>
      code(rt.call("member.set", { space: team, member, role, until }, { actor: ana }));
    assertEquals(await set(bob, "editor", "tomorrow"), "invalid");
    assertEquals(await set(bob, "editor", new Date(Date.now() - HOUR).toISOString()), "invalid");
    const later = new Date(Date.now() + HOUR).toISOString();
    // Ana manages Team alone: she can't be given an end, nor can Bob be its only lasting manager.
    assertEquals(await set(ana, "manager", later), "forbidden");
    assertEquals(await set(bob, "manager", later), "done");
    assertEquals(await set(ana, "manager", later), "forbidden");
    await rt.call("member.set", { space: team, member: bob, role: "manager" }, { actor: ana });
    assertEquals(await set(ana, "manager", later), "done");
  });
});
