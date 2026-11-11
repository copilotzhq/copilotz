/**
 * Labels: what a job read goes with what it writes. An answer written in
 * Launch from what's in Finance carries Finance as a source: only those who
 * reach both read it, until someone who does shares it. An agent can't
 * write it anywhere else, nor where labels aren't kept. Except an agent
 * working for someone from their own Personal space: what it does there for
 * them is theirs, as if they'd done it, wherever they may; in Personal itself,
 * what keeps labels keeps its marks, for the day its chat moves.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
/** An agent working for Ana in Launch. */
const north: Actor = { kind: "agent", id: "north", for: ana, in: "launch" };

type Doc = { _id: string; in: string; text: string; sources?: string[] };
const text = { type: "string" } as const;
const doc = { type: "object", properties: { in: text, text }, required: ["in", "text"] } as const;

const app = definePlugin({
  name: "app",
  // Answers keep labels; notes don't.
  resources: { shared: { note: {}, answer: { labels: true } } },
  collections: {
    note: defineCollection({ schema: doc }),
    answer: defineCollection({ schema: doc }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
      allow: () => true,
      run: (ctx, input) => ctx.db.collection("note").insertOne(input),
    }),
    // Reads the notes in some spaces, then writes what they say somewhere.
    summarize: defineAction({
      input: {
        type: "object",
        properties: {
          from: { type: "array", items: text },
          into: text,
          as: { type: "string", enum: ["note", "answer"] },
          id: text,
        },
        required: ["from", "into", "as"],
      },
      allow: () => true,
      run: async (ctx, input) => {
        const read = await ctx.db.collection<Doc>("note").find({ in: { $in: input.from } });
        await ctx.db.collection(input.as).insertOne({
          ...(input.id ? { _id: input.id } : {}),
          in: input.into,
          text: read.map((n) => n.text).sort().join(" + "),
        });
      },
    }),
    "doc.find": defineAction({
      input: {
        type: "object",
        properties: { collection: { type: "string", enum: ["note", "answer"] }, id: text },
        required: ["collection", "id"],
      },
      allow: () => true,
      run: (ctx, input) => ctx.db.collection<Doc>(input.collection).find({ _id: input.id }),
    }),
    "answer.list": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: async (ctx) =>
        (await ctx.db.collection<Doc>("answer").find({}, { sort: { text: 1 } })).map((a) => a.text),
    }),
  },
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

/** North works in `space` too (Ana adds it). */
const hire = (rt: Runtime, space: string) =>
  rt.call("member.set", { space, member: { kind: "agent", id: "north" }, role: "editor" }, {
    actor: ana,
  });

const each = (name: string, fn: (runtime: Runtime) => Promise<void>) => {
  for (const [kind, make] of Object.entries(stores)) {
    test(`${kind}: ${name}`, async () => {
      const runtime = await createRuntime({ store: await make(), plugins: [...access, app] });
      try {
        // Ana and Bob work in Launch; Finance is Ana's alone. North works in both.
        await runtime.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
        await runtime.call("space.create", { id: "finance", name: "Finance" }, { actor: ana });
        await join(runtime, "launch", bob, "editor", ana);
        for (const space of ["launch", "finance"]) await hire(runtime, space);
        await runtime.call("note.add", { in: "launch", text: "plan" }, { actor: ana });
        await runtime.call("note.add", { in: "finance", text: "budget" }, { actor: ana });
        await fn(runtime);
      } finally {
        await runtime.close();
      }
    });
  }
};

const answers = (rt: Runtime, actor: Actor) => rt.call<string[]>("answer.list", {}, { actor });

each("an answer from a space not everyone sees carries it, until it's shared", async (rt) => {
  // From Launch alone: no labels, everyone in Launch reads it.
  await rt.call("summarize", { from: ["launch"], into: "launch", as: "answer" }, { actor: ana });
  // From Launch and Finance, into Launch: it carries Finance.
  await rt.call("summarize", {
    id: "a2",
    from: ["launch", "finance"],
    into: "launch",
    as: "answer",
  }, { actor: ana });
  assertEquals(await answers(rt, ana), ["budget + plan", "plan"]);
  assertEquals(await answers(rt, bob), ["plan"]);
  // Bob can't show it: he doesn't see Finance. Ana can.
  await assertRejects(
    () => rt.call("share", { collection: "answer", id: "a2" }, { actor: bob }),
    Error,
    "can't see finance",
  );
  assertEquals(await rt.call("share", { collection: "answer", id: "a2" }, { actor: ana }), {
    shared: ["finance"],
  });
  assertEquals(await answers(rt, bob), ["budget + plan", "plan"]);
});

each("an agent works where it is, and takes nothing from elsewhere", async (rt) => {
  // In Launch, it reads Launch alone: Finance isn't there for it, so its answer carries nothing.
  await rt.call("summarize", { from: ["launch", "finance"], into: "launch", as: "answer" }, {
    actor: north,
  });
  assertEquals(await answers(rt, bob), ["plan"]);
  await rt.call("summarize", { from: ["launch", "finance"], into: "launch", as: "note" }, {
    actor: north,
  });
  // Nor does it write anywhere else, though it works in Marketing too: handing work over is a
  // person's (or trusted code's) to do.
  await rt.call("space.create", { id: "marketing", name: "Marketing" }, { actor: ana });
  await hire(rt, "marketing");
  await assertRejects(
    () =>
      rt.call("summarize", { from: ["launch"], into: "marketing", as: "note" }, { actor: north }),
    Error,
    "out of your reach",
  );
  // In Ana's Personal space only she sees what's said: there it reaches all she does, and what
  // it writes carries where it came from.
  const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
    actor: ana,
  });
  await hire(rt, personal);
  const mine: Actor = { ...north, in: personal };
  await rt.call("summarize", { from: ["launch", "finance"], into: personal, as: "answer" }, {
    actor: mine,
  });
  // (Launch's notes: Ana's, and the one it wrote there.)
  assertEquals(await answers(rt, ana), ["budget + plan + plan", "plan"]);
  assertEquals(await answers(rt, bob), ["plan"]);
  // What it does from there is Ana's, as if she'd done it: written in Launch, it's for Launch's
  // people, Finance's budget too, since she asked; and where labels aren't kept, it goes as well.
  await rt.call("summarize", { from: ["launch", "finance"], into: "launch", as: "answer" }, {
    actor: mine,
  });
  assert((await answers(rt, bob)).some((a) => a.includes("budget")), "Ana's to show Bob");
  // What it writes in her Personal space itself, where labels are kept, keeps its marks, for the
  // day its chat moves; anything else there (a note, a board, a file) goes as it is: only she sees
  // it, and moving it is hers to do.
  await rt.call("summarize", {
    id: "p1",
    from: ["launch", "finance"],
    into: personal,
    as: "answer",
  }, {
    actor: mine,
  });
  const marked = await rt.call<Doc[]>("doc.find", { collection: "answer", id: "p1" }, {
    actor: ana,
  });
  assertEquals(marked.map((d) => d.sources), [["finance", "launch"]]);
  await rt.call(
    "summarize",
    { id: "n1", from: ["launch", "finance"], into: personal, as: "note" },
    {
      actor: mine,
    },
  );
  const noted = await rt.call<Doc[]>("doc.find", { collection: "note", id: "n1" }, { actor: ana });
  assertEquals(noted.map((d) => [d.text, d.sources]), [["budget + plan + plan", undefined]]);
  assertEquals(
    await rt.call<Doc[]>("doc.find", { collection: "note", id: "n1" }, { actor: bob }),
    [],
  );
  // Working for her in Launch, it still takes nothing from elsewhere (above): Bob reads there.
});
