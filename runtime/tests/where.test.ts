/**
 * Who, for whom, where: work runs as an actor, for whom it's done (`for`),
 * and where (`in`), which the runtime carries as it carries the actor: into
 * nested calls, the Processors its events wake, its timers and the Views
 * observed for it, on every event. An Action's `allow` is asked wherever an
 * actor calls, from code acting for them too, and for an agent, for whom it
 * works for as well; what has none is internal. Going beyond is a grant of
 * the system's, on the record. What the rules work out is kept until a
 * commit changes what it read.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  grant,
  inPerson,
  manualClock,
  people,
  peopleOrContacts,
  personOf,
  type Runtime,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const carla: Actor = { kind: "contact", id: "carla" };
const forAna: Actor = { kind: "agent", id: "north", for: ana, in: "launch" };
const forCarla: Actor = { kind: "agent", id: "desk", for: carla, in: "support" };
const text = { type: "string" } as const;
const anything = { type: "object" } as const;

/** Where each piece of work found itself, by what it was. */
const seen: Record<string, unknown> = {};

const plugin = definePlugin({
  name: "where",
  events: { "where.pinged": { schema: anything } },
  collections: {
    note: defineCollection({ schema: { type: "object", properties: { text } } }),
  },
  actions: {
    // Says where it ran, and has what it causes say so too.
    "where.start": defineAction({
      input: anything,
      allow: () => true,
      run: async (ctx) => {
        seen.call = ctx.in;
        seen.nested = await ctx.call("where.here", {});
        seen.as = ctx.as({ kind: "person", id: "bob" }).in;
        seen.elsewhere = ctx.as({ kind: "person", id: "bob", in: "finance" }).in;
        seen.nowhere = ctx.as({ kind: "person", id: "bob", in: undefined }).in;
        seen.system = ctx.as().in;
        await ctx.emit("where.pinged", {});
        await ctx.schedule("where.later", {}, { at: new Date(Date.now() + 60_000).toISOString() });
        await ctx.db.collection("note").insertOne({ text: "written" });
      },
    }),
    "where.here": defineAction({ input: anything, run: (ctx) => ctx.in ?? null }),
    "where.later": defineAction({
      input: anything,
      run: (ctx) => void (seen.timer = ctx.in),
    }),
    // What people may do, an agent working for one may too; what only they decide, never.
    "do.people": defineAction({ input: anything, allow: people, run: () => "done" }),
    "do.inPerson": defineAction({ input: anything, allow: inPerson, run: () => "done" }),
    "do.contacts": defineAction({ input: anything, allow: peopleOrContacts, run: () => "done" }),
    // A custom `allow` that names agents: an agent still needs whom it works for let in too.
    "do.agents": defineAction({
      input: anything,
      allow: (actor) => actor.kind === "agent" || actor.kind === "person",
      run: () => "done",
    }),
    "do.internal": defineAction({ input: anything, run: () => "done" }),
    // Code acting for someone calls another Action, as them, or beyond them by a grant.
    "do.through": defineAction({
      input: {
        type: "object",
        properties: {
          action: text,
          granted: { type: "boolean" },
          asPerson: { type: "boolean" },
        },
        required: ["action"],
      },
      allow: () => true,
      run: async (ctx, { action, granted, asPerson }) =>
        await (granted
          ? ctx.as(grant("test.beyond"))
          : asPerson
          ? ctx.as({ kind: "person", id: personOf(ctx.actor)! })
          : ctx).call(action, {}),
    }),
  },
  processors: {
    "where.pinged": { on: "where.pinged", run: (ctx) => void (seen.processor = ctx.in) },
  },
  views: {
    // Where it's shown, and its handler calls from there.
    here: (_item: unknown, ctx: ViewContext) => ({
      in: ctx.in ?? null,
      go: () => ctx.call("where.start", {}),
    }),
  },
});

const each = async (fn: (rt: Runtime) => Promise<void>, clock = manualClock(Date.now())) => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [plugin], clock });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
};

test("where work is travels with everything it causes, and every event records it", async () => {
  for (const key of Object.keys(seen)) delete seen[key];
  const clock = manualClock(Date.now());
  await each(async (rt) => {
    const events: Event[] = [];
    rt.subscribe((item) => item.kind === "event" && events.push(item.event));
    await rt.call("where.start", {}, { actor: { ...ana, in: "launch" } });
    await rt.idle();
    clock.advance(61_000);
    await rt.wake();
    await rt.idle();
    assertEquals(seen, {
      call: "launch",
      nested: "launch",
      // Acting as someone else stays where the work is, unless it says where.
      as: "launch",
      elsewhere: "finance",
      nowhere: undefined,
      system: "launch",
      processor: "launch",
      timer: "launch",
    });
    const written = events.find((e) => e.type === "note.created")!;
    assertEquals(written.actor?.in, "launch");
    assertEquals(events.find((e) => e.type === "where.pinged")?.actor?.in, "launch");
  }, clock);
});

test("a View says where it's observed, and its handlers call from there", async () => {
  for (const key of Object.keys(seen)) delete seen[key];
  await each(async (rt) => {
    const view = rt.observe<{ in: string | null; go(): Promise<unknown> }>("here", {}, {
      actor: { ...ana, in: "launch" },
    });
    const shown = await view.ready;
    assert(shown.status === "ready");
    assertEquals(shown.value.in, "launch");
    await shown.value.go();
    assertEquals(seen.call, "launch");
    view.close();
    // Nowhere: none.
    const plain = rt.observe<{ in: string | null }>("here", {}, { actor: ana });
    const value = await plain.ready;
    assert(value.status === "ready");
    assertEquals(value.value.in, null);
    plain.close();
  });
});

test("code acting for someone calls only what lets them; an agent, what lets its person too", async () => {
  await each(async (rt) => {
    const through = (actor: Actor, action: string, granted = false) =>
      rt.call("do.through", { action, ...(granted ? { granted } : {}) }, { actor });
    // A person: what people may, and what only they decide.
    assertEquals(await through(ana, "do.people"), "done");
    assertEquals(await through(ana, "do.inPerson"), "done");
    // Their agent: what people may, never what only they decide.
    assertEquals(await through(forAna, "do.people"), "done");
    assertEquals(await through(forAna, "do.agents"), "done");
    await assertRejects(() => through(forAna, "do.inPerson"), Error, "may not call");
    // A contact, and its agent: only what's open to contacts.
    await assertRejects(() => through(carla, "do.people"), Error, "may not call");
    await assertRejects(() => through(forCarla, "do.people"), Error, "may not call");
    assertEquals(await through(forCarla, "do.contacts"), "done");
    // An `allow` that lets agents in still asks for whom it works.
    await assertRejects(() => through(forCarla, "do.agents"), Error, "may not call");
    // What has no `allow` is internal: code calls it for anyone; nobody calls it from outside.
    assertEquals(await through(forCarla, "do.internal"), "done");
    await assertRejects(
      () => rt.call("do.internal", {}, { actor: ana }),
      Error,
      "may not call",
    );
    // From outside, the same: an agent needs its person let in too.
    assertEquals(await rt.call("do.people", {}, { actor: forAna }), "done");
    await assertRejects(() => rt.call("do.agents", {}, { actor: forCarla }), Error, "may not call");
    // A routine's work (an `origin`), and code acting as an agent's person, aren't the person in
    // person; code acting as a person for themselves is.
    await assertRejects(
      () => through({ ...ana, origin: { kind: "routine", id: "r1" } }, "do.inPerson"),
      Error,
      "may not call",
    );
    const asPerson = (actor: Actor) =>
      rt.call("do.through", { action: "do.inPerson", asPerson: true }, { actor });
    await assertRejects(() => asPerson(forAna), Error, "may not call");
    assertEquals(await asPerson(ana), "done");
  });
});

test("going beyond whom it acts for is a named grant, on the record", async () => {
  await each(async (rt) => {
    const events: Event[] = [];
    rt.subscribe((item) => item.kind === "event" && events.push(item.event));
    assertEquals(
      await rt.call("do.through", { action: "do.inPerson", granted: true }, { actor: forCarla }),
      "done",
    );
    await rt.idle();
    const started = events.find((e) =>
      e.type === "action.started" && e.data.action === "do.inPerson"
    );
    assertEquals(started?.actor?.kind, "system");
    assertEquals(started?.actor?.id, "test.beyond");
    assertEquals((started?.actor?.via as Actor).id, "desk");
    // And where it was.
    assertEquals(started?.actor?.in, "support");
  });
});

/**
 * A rule that works out, through `kept`, which notes each person may read (their grants), and
 * counts how often it does.
 */
let worked = 0;
const kept = definePlugin({
  name: "kept",
  collections: {
    page: defineCollection({
      schema: { type: "object", properties: { book: text, text }, required: ["book"] },
      queries: {
        all: {
          allow: () => true,
          run: (pages) => pages.find({}, { sort: { text: 1 } }),
        },
      },
    }),
    lend: defineCollection({
      schema: { type: "object", properties: { to: text, book: text }, required: ["to", "book"] },
    }),
  },
  actions: {
    "page.add": defineAction({
      input: { type: "object", properties: { book: text, text }, required: ["book", "text"] },
      run: (ctx, input) => ctx.db.collection("page").insertOne(input),
    }),
    "lend.add": defineAction({
      input: { type: "object", properties: { to: text, book: text }, required: ["to", "book"] },
      run: (ctx, input) => ctx.db.collection("lend").insertOne(input),
    }),
  },
  guard: async (actor, { collection }, ctx) => {
    if (collection !== "page") return undefined;
    const books = await ctx.kept(`books:${actor.id}`, async (ctx) => {
      worked++;
      return (await ctx.db.collection<{ book: string }>("lend").find({ to: actor.id }))
        .map((l) => l.book);
    });
    return { book: { $in: books } };
  },
  views: {
    pages: (_: unknown, ctx: ViewContext) => {
      const read = ctx.db.collection<{ text: string }>("page").find({}, { sort: { text: 1 } });
      return read.status === "ready" ? read.value.map((p) => p.text) : [];
    },
  },
});

test("what the rules work out is kept until a commit changes what it read", async () => {
  worked = 0;
  const rt = await createRuntime({ store: memoryStore(), plugins: [kept] });
  try {
    await rt.call("page.add", { book: "a", text: "a1" });
    await rt.call("page.add", { book: "b", text: "b1" });
    await rt.call("lend.add", { to: "ana", book: "a" });
    const pages = async () =>
      (await rt.query<{ text: string }[]>("page.all", {}, { actor: ana })).map((p) => p.text);
    assertEquals(await pages(), ["a1"]);
    assertEquals(await pages(), ["a1"]);
    assertEquals(await pages(), ["a1"]);
    assertEquals(worked, 1, "worked out once");
    // A change to what it didn't read (another's lending, another collection) keeps it.
    await rt.call("lend.add", { to: "bob", book: "b" });
    await rt.call("page.add", { book: "a", text: "a2" });
    assertEquals(await pages(), ["a1", "a2"]);
    assertEquals(worked, 1, "nothing it read changed");
    // Lent another book: worked out again, once.
    await rt.call("lend.add", { to: "ana", book: "b" });
    assertEquals(await pages(), ["a1", "a2", "b1"]);
    assertEquals(await pages(), ["a1", "a2", "b1"]);
    assertEquals(worked, 2);
    // A View observed for her follows what the rule read, kept or not.
    const view = rt.observe<string[]>("pages", {}, { actor: { kind: "person", id: "cy" } });
    assertEquals((await view.ready as { value: string[] }).value, []);
    await rt.call("lend.add", { to: "cy", book: "b" });
    await rt.idle();
    const now = view.get();
    assert(now.status === "ready");
    assertEquals(now.value, ["b1"]);
    view.close();
  } finally {
    await rt.close();
  }
});
