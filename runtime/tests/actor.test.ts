/**
 * Who acts: an outside call binds an actor, and everything it causes is
 * theirs (nested calls, events, Processors, timers). Actions say whom they
 * let call them; a guard's rules are filters every operation keeps to; the
 * system, and trusted code acting as it, is unrestricted.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  type Runtime,
  type Store,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

type Note = { _id: string; owner: string; text: string };
const text = { type: "string" } as const;
const person = (actor: Actor) => actor.kind === "person";

const plugin = definePlugin({
  name: "notes",
  events: {
    "note.counted": { schema: { type: "object", properties: { n: { type: "integer" } } } },
    "note.echoed": { schema: { type: "object" } },
  },
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { owner: text, text }, required: ["owner", "text"] },
      queries: {
        all: { allow: person, run: (notes) => notes.find({}, { sort: { text: 1 } }) },
        // A query knows who asks.
        asker: { allow: person, run: (_, __, ctx) => Promise.resolve(ctx.actor?.id ?? "system") },
        // Lets no one from outside: the system's, and plugin code's.
        count: (notes) => notes.countDocuments({}),
      },
    }),
    // No rule: code acting for anyone reads and writes it unchecked.
    tally: defineCollection({ schema: { type: "object", properties: { n: { type: "number" } } } }),
  },
  actions: {
    "note.add": defineAction({
      allow: person,
      input: { type: "object", properties: { text, owner: text } },
      run: async (ctx, input) => {
        await ctx.db.collection("note").insertOne({
          owner: input.owner ?? ctx.actor?.id ?? "system",
          text: input.text ?? "",
        });
        await ctx.call("tally.bump", {});
      },
    }),
    "tally.bump": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("tally").updateOne({ _id: "n" }, { $inc: { n: 1 } }, { upsert: true }),
    }),
    "note.mine": defineAction({
      allow: person,
      input: { type: "object" },
      run: async (ctx) =>
        (await ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } })).map((n) => n.text),
    }),
    "note.everyone": defineAction({
      allow: person,
      input: { type: "object" },
      // Trusted code acting as the system: it reads everything, and says for whom.
      run: async (ctx) => {
        const all = await ctx.as().db.collection<Note>("note").find({}, { sort: { text: 1 } });
        await ctx.as().emit("note.counted", { n: all.length });
        return all.map((n) => n.text);
      },
    }),
    "note.give": defineAction({
      allow: person,
      input: { type: "object", properties: { to: text }, required: ["to"] },
      run: (ctx, input) => ctx.db.collection("note").updateMany({}, { $set: { owner: input.to } }),
    }),
    // Writing a note by its id, whether it's there yet or not.
    "note.put": defineAction({
      allow: person,
      input: { type: "object", properties: { id: text, text }, required: ["id", "text"] },
      run: (ctx, input) =>
        ctx.db.collection("note").replaceOne(
          { _id: input.id },
          { owner: ctx.actor!.id, text: input.text },
          { upsert: true },
        ),
    }),
    "note.set": defineAction({
      allow: person,
      input: { type: "object", properties: { id: text, text }, required: ["id", "text"] },
      run: (ctx, input) =>
        ctx.db.collection("note").updateOne(
          { _id: input.id },
          { $set: { text: input.text } },
          { upsert: true },
        ),
    }),
    "note.wipe": defineAction({
      allow: person,
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("note").deleteMany({}),
    }),
    "note.later": defineAction({
      allow: person,
      input: { type: "object" },
      run: (ctx) => ctx.schedule("note.add", { text: "later" }, { at: new Date().toISOString() }),
    }),
    secret: defineAction({ input: { type: "object" }, run: () => "hidden" }),
  },
  processors: {
    // A Processor runs as the actor of the event it handles.
    "note.echo": {
      on: "note.created",
      where: { "doc.text": "echo" },
      run: (ctx, event) => ctx.emit("note.echoed", { note: event.data._id }),
    },
  },
  views: {
    notes: {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } }).value ?? []).map((n) =>
          n.text
        ),
    },
    // A View knows whom it renders as, wherever it's drawn.
    whoami: { test: (_: unknown, ctx: ViewContext) => ctx.actor?.id ?? "system" },
  },
  // Each person reaches their own notes.
  guard: (actor, { collection }) => collection === "note" ? { owner: actor.id } : undefined,
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

const each = (name: string, fn: (runtime: Runtime, store: Store) => Promise<void>) => {
  for (const [kind, make] of Object.entries(stores)) {
    test(`${kind}: ${name}`, async () => {
      const store = await make();
      const runtime = await createRuntime({ store, plugins: [plugin] });
      try {
        await fn(runtime, store);
      } finally {
        await runtime.close();
      }
    });
  }
};

const by = (events: Event[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.actor?.id ?? "system");

each("actors call and query only what lets them; the system anything", async (rt) => {
  await assertRejects(() => rt.call("secret", {}, { actor: ana }), Error, "may not call");
  await assertRejects(() => rt.query("note.count", {}, { actor: ana }), Error, "may not run");
  assertEquals(await rt.query("note.count", {}), 0);
  await assertRejects(
    () => rt.call("note.add", { text: "x" }, { actor: { kind: "key", id: "k1" } }),
    Error,
    "may not call",
  );
  assertEquals(await rt.call("secret", {}), "hidden");
});

each("everything an actor's call causes is theirs, events included", async (rt, store) => {
  await rt.call("note.add", { text: "echo" }, { actor: ana });
  await rt.idle();
  const events = await store.events(0, 100);
  // The call, its nested call, its writes, and what a Processor did about them.
  assertEquals(by(events, "action.started"), ["ana", "ana"]);
  assertEquals(by(events, "note.created"), ["ana"]);
  assertEquals(by(events, "tally.created"), ["ana"]);
  assertEquals(by(events, "note.echoed"), ["ana"]);
  assertEquals(by(events, "action.completed"), ["ana", "ana"]);
});

each("rules are filters: an actor reads, changes and removes only what they reach", async (rt) => {
  await rt.call("note.add", { text: "a1" }, { actor: ana });
  await rt.call("note.add", { text: "a2" }, { actor: ana });
  await rt.call("note.add", { text: "b1" }, { actor: bob });

  assertEquals(await rt.call("note.mine", {}, { actor: ana }), ["a1", "a2"]);
  assertEquals(await rt.call("note.mine", {}, { actor: bob }), ["b1"]);
  assertEquals(await rt.query("note.all", {}, { actor: bob }), [
    { _id: (await rt.query<Note[]>("note.all"))[2]._id, owner: "bob", text: "b1" },
  ]);
  // A note made for someone else would be out of reach: refused, nothing written.
  await assertRejects(
    () => rt.call("note.add", { text: "planted", owner: "bob" }, { actor: ana }),
    Error,
    "out of your reach",
  );
  // Giving notes away would put them out of reach: refused, all of it.
  await assertRejects(() => rt.call("note.give", { to: "bob" }, { actor: ana }), Error, "reach");
  assertEquals(await rt.call("note.mine", {}, { actor: ana }), ["a1", "a2"]);
  // Removing everything removes only what's yours.
  await rt.call("note.wipe", {}, { actor: bob });
  assertEquals((await rt.query<Note[]>("note.all")).map((n) => n.text), ["a1", "a2"]);
});

each("an upsert under a rule makes the document it names, and takes no one else's", async (rt) => {
  await rt.call("note.put", { id: "n1", text: "ana's" }, { actor: ana });
  // An update's new document starts from the rule's equalities too: it's hers.
  await rt.call("note.set", { id: "n2", text: "also ana's" }, { actor: ana });
  assertEquals(await rt.query("note.all", {}, { actor: ana }), [
    { _id: "n2", owner: "ana", text: "also ana's" },
    { _id: "n1", owner: "ana", text: "ana's" },
  ]);
  // Bob can't reach n1: upserting it can't write over hers.
  for (const action of ["note.put", "note.set"]) {
    await assertRejects(() => rt.call(action, { id: "n1", text: "bob's" }, { actor: bob }));
  }
  assertEquals((await rt.query<Note[]>("note.all")).map((n) => [n._id, n.owner, n.text]), [
    ["n2", "ana", "also ana's"],
    ["n1", "ana", "ana's"],
  ]);
});

each("trusted code acts as the system, on the record", async (rt, store) => {
  await rt.call("note.add", { text: "a1" }, { actor: ana });
  await rt.call("note.add", { text: "b1" }, { actor: bob });
  assertEquals(await rt.call("note.everyone", {}, { actor: ana }), ["a1", "b1"]);
  const [counted] = (await store.events(0, 100)).filter((e) => e.type === "note.counted");
  assertEquals(counted.actor, { kind: "system", id: "system", via: ana });
});

each("a timer an actor sets runs as them", async (rt, store) => {
  await rt.call("note.later", {}, { actor: ana });
  await rt.idle();
  for (let i = 0; i < 50 && !(await rt.query<Note[]>("note.all")).length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rt.idle();
  }
  assertEquals((await rt.query<Note[]>("note.all")).map((n) => [n.owner, n.text]), [
    ["ana", "later"],
  ]);
  assertEquals(by(await store.events(0, 100), "note.created"), ["ana"]);
});

each("an actor's observed View shows what they reach", async (rt) => {
  await rt.call("note.add", { text: "a1" }, { actor: ana });
  await rt.call("note.add", { text: "b1" }, { actor: bob });
  const notes = rt.observe<string[]>("test", "notes", {}, { actor: ana });
  assertEquals(await notes.ready, { status: "ready", value: ["a1"] });
  await rt.call("note.add", { text: "b2" }, { actor: bob });
  await rt.call("note.add", { text: "a2" }, { actor: ana });
  await rt.idle();
  assertEquals(notes.get(), { status: "ready", value: ["a1", "a2"] });
  notes.close();
  assert(true);
});

each("queries and Views know who reads", async (rt) => {
  assertEquals(await rt.query("note.asker", {}, { actor: ana }), "ana");
  assertEquals(await rt.query("note.asker", {}), "system");
  const seen = rt.observe<string>("test", "whoami", {}, { actor: bob });
  assertEquals(await seen.ready, { status: "ready", value: "bob" });
  seen.close();
  assertEquals(await rt.render("test", "whoami", {}), "system");
});
