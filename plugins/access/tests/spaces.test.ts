/**
 * Spaces: an actor reaches the spaces they're a member of and those they
 * draw on, with what the roles along the path allow; every shared collection
 * keeps to it, for reads, writes and observed Views; agents acting for
 * someone reach what both reach.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type Store,
  type ViewContext,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const north = (person: Actor): Actor => ({ kind: "agent", id: "north", for: person });

type Note = { _id: string; in: string; text: string };
const text = { type: "string" } as const;

const app = definePlugin({
  name: "app",
  resources: { shared: { note: {} } },
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
      indexes: [["in"]],
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { in: text, text, id: text }, required: ["in", "text"] },
      allow: () => true,
      run: (ctx, input) =>
        ctx.db.collection("note").insertOne({
          ...(input.id ? { _id: input.id } : {}),
          in: input.in,
          text: input.text,
        }),
    }),
    "note.list": defineAction({
      input: { type: "object", properties: { in: text } },
      allow: () => true,
      run: async (ctx, input) =>
        (await ctx.db.collection<Note>("note").find(input.in ? { in: input.in } : {}, {
          sort: { text: 1 },
        })).map((n) => n.text),
    }),
    "note.move": defineAction({
      input: { type: "object", properties: { id: text, to: text }, required: ["id", "to"] },
      allow: () => true,
      run: (ctx, input) =>
        ctx.db.collection("note").updateOne({ _id: input.id }, { $set: { in: input.to } }),
    }),
  },
  views: {
    notes: {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } }).value ?? []).map((n) =>
          n.text
        ),
    },
  },
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

const each = (name: string, fn: (runtime: Runtime) => Promise<void>) => {
  for (const [kind, make] of Object.entries(stores)) {
    test(`${kind}: ${name}`, async () => {
      const runtime = await createRuntime({ store: await make(), plugins: [...access, app] });
      try {
        await fn(runtime);
      } finally {
        await runtime.close();
      }
    });
  }
};

const list = (rt: Runtime, actor: Actor, where?: string) =>
  rt.call<string[]>("note.list", where ? { in: where } : {}, { actor });

each("members reach a space's documents, with what their role allows", async (rt) => {
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  await rt.call("note.add", { in: "launch", text: "plan" }, { actor: ana });
  // Bob isn't a member: he sees nothing there, and can't write there.
  assertEquals(await list(rt, bob), []);
  assertEquals(await list(rt, bob, "launch"), []);
  await assertRejects(
    () => rt.call("note.add", { in: "launch", text: "hi" }, { actor: bob }),
    Error,
    "out of your reach",
  );
  // A viewer reads, and still can't write; an editor writes.
  await join(rt, "launch", bob, "viewer", ana);
  assertEquals(await list(rt, bob, "launch"), ["plan"]);
  await assertRejects(() => rt.call("note.add", { in: "launch", text: "hi" }, { actor: bob }));
  await rt.call("member.set", { space: "launch", member: bob, role: "editor" }, { actor: ana });
  await rt.call("note.add", { in: "launch", text: "hi" }, { actor: bob });
  assertEquals(await list(rt, ana), ["hi", "plan"]);
  // Only managers change members.
  await assertRejects(
    () => rt.call("member.set", { space: "launch", member: bob, role: "manager" }, { actor: bob }),
    Error,
    "don't manage",
  );
  // Removed, he reaches nothing again.
  await rt.call("member.remove", { space: "launch", member: bob }, { actor: ana });
  assertEquals(await list(rt, bob), []);
});

each("a document can't be moved where you can't write", async (rt) => {
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  await rt.call("space.create", { id: "finance", name: "Finance" }, { actor: bob });
  await rt.call("note.add", { id: "n1", in: "launch", text: "plan" }, { actor: ana });
  await assertRejects(
    () => rt.call("note.move", { id: "n1", to: "finance" }, { actor: ana }),
    Error,
    "out of your reach",
  );
  assertEquals(await list(rt, ana, "launch"), ["plan"]);
  // Someone else's document isn't moved at all: their update reaches nothing.
  await rt.call("note.move", { id: "n1", to: "finance" }, { actor: bob });
  assertEquals(await list(rt, bob), []);
});

each("a space drawing on another reaches it, as far as its role there allows", async (rt) => {
  await rt.call("space.create", { id: "marketing", name: "Marketing" }, { actor: bob });
  await rt.call("note.add", { in: "marketing", text: "brand" }, { actor: bob });
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  // Launch draws on Marketing, as a viewer: Launch's members read Marketing.
  await rt.call("member.set", {
    space: "marketing",
    member: { kind: "space", id: "launch" },
    role: "viewer",
  }, { actor: bob });
  assertEquals(await list(rt, ana), ["brand"]);
  await assertRejects(() => rt.call("note.add", { in: "marketing", text: "x" }, { actor: ana }));
});

each("an agent acting for someone reaches what both reach", async (rt) => {
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  await rt.call("space.create", { id: "finance", name: "Finance" }, { actor: ana });
  await rt.call("note.add", { in: "launch", text: "plan" }, { actor: ana });
  await rt.call("note.add", { in: "finance", text: "salaries" }, { actor: ana });
  // An agent works only where it's a member: North, nowhere yet.
  assertEquals(await list(rt, north(ana)), []);
  for (const space of ["launch", "finance"]) {
    await rt.call("member.set", { space, member: { kind: "agent", id: "north" }, role: "viewer" }, {
      actor: ana,
    });
  }
  assertEquals(await list(rt, north(ana)), ["plan", "salaries"]);
  // Taken out of Finance, for Ana, North sees Launch, not Finance.
  await rt.call("member.remove", { space: "finance", member: { kind: "agent", id: "north" } }, {
    actor: ana,
  });
  assertEquals(await list(rt, north(ana)), ["plan"]);
  // Agents never manage.
  await assertRejects(
    () =>
      rt.call("member.set", {
        space: "launch",
        member: { kind: "agent", id: "north" },
        role: "manager",
      }, { actor: ana }),
    Error,
    "viewers or editors",
  );
  // For Bob, who reaches neither, nothing.
  assertEquals(await list(rt, north(bob)), []);
});

each("a document shared on its own reaches its own members", async (rt) => {
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  await rt.call("note.add", { id: "n1", in: "launch", text: "plan" }, { actor: ana });
  await rt.call("note.add", { id: "n2", in: "launch", text: "budget" }, { actor: ana });
  await rt.call("member.set", { space: "n1", on: "note", member: bob, role: "viewer" }, {
    actor: ana,
  });
  assertEquals(await list(rt, bob), ["plan"]);
});

each("someone's Personal space is theirs alone; Views show what you reach", async (rt) => {
  const mine = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
  await rt.call("note.add", { in: mine.space, text: "diary" }, { actor: ana });
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: bob });
  await rt.call("note.add", { in: "launch", text: "plan" }, { actor: bob });
  const notes = rt.observe<string[]>("test", "notes", {}, { actor: ana });
  assertEquals(await notes.ready, { status: "ready", value: ["diary"] });
  // Let in, she sees more at once: what the rules read to know her reach, the View follows.
  await join(rt, "launch", ana, "viewer", bob);
  await rt.idle();
  assertEquals(notes.get(), { status: "ready", value: ["diary", "plan"] });
  await rt.call("member.remove", { space: "launch", member: ana }, { actor: bob });
  await rt.idle();
  assertEquals(notes.get(), { status: "ready", value: ["diary"] });
  notes.close();
  assertEquals(await list(rt, bob), ["plan"]);
  // Nobody joins it but agents: not Bob, not a space drawing on it.
  for (const member of [bob, { kind: "space", id: "launch" }]) {
    await assertRejects(
      () => rt.call("member.set", { space: mine.space, member, role: "viewer" }, { actor: ana }),
      Error,
      "Personal space is its person's alone",
    );
  }
  await rt.call("member.set", {
    space: mine.space,
    member: { kind: "agent", id: "north" },
    role: "editor",
  }, {
    actor: ana,
  });
  assertEquals(await list(rt, bob), ["plan"]);
});

each("the spaces you reach say what you may do there; managers rename theirs", async (rt) => {
  const mine = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
  await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
  await join(rt, "launch", bob, "editor", ana);
  type Reached = { _id: string; name: string; can: string[] };
  const reached = async (actor: Actor) =>
    (await rt.query<Reached[]>("space.reached", {}, { actor }))
      .map((s) => [s._id, s.name, s.can.sort().join(" ")]);
  assertEquals(await reached(ana), [
    ["launch", "Launch", "manage read write"],
    [mine.space, "Personal", "manage read write"],
  ]);
  assertEquals(await reached(bob), [["launch", "Launch", "read write"]]);
  // An editor doesn't rename it; a manager does; nobody renames a Personal space.
  await assertRejects(
    () => rt.call("space.rename", { space: "launch", name: "Liftoff" }, { actor: bob }),
    Error,
    "don't manage",
  );
  assertEquals(
    await rt.call("space.rename", { space: "launch", name: "  Liftoff " }, { actor: ana }),
    { space: "launch", name: "Liftoff" },
  );
  assertEquals((await reached(bob))[0][1], "Liftoff");
  await assertRejects(
    () => rt.call("space.rename", { space: mine.space, name: "Mine" }, { actor: ana }),
    Error,
    "keeps its name",
  );
  await assertRejects(
    () => rt.call("space.rename", { space: mine.space, name: "Mine" }, { actor: bob }),
    Error,
    "don't manage",
  );
  await assertRejects(() =>
    rt.call("space.rename", { space: "launch", name: "   " }, { actor: ana })
  );
});
