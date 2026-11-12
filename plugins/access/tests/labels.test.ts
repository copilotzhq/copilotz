/**
 * Where an agent's work may go. Working for Ana in Launch, it reads Launch
 * alone, and what it writes there shows Launch's people nothing they couldn't
 * see. In Ana's own Personal space, which only she sees, it reads all she
 * does; writing what that could hold anywhere whose people don't all see it
 * (Launch) waits for her yes (`needs_approval`, until the work carries it:
 * `approved`). A person's own writing goes wherever they may, as it is. What
 * an agent writes in a collection that keeps it (`drew: true`) says which
 * other spaces its work read: on the record, never in the way of a reader.
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

type Doc = { _id: string; in: string; text: string; drew?: string[] };
const text = { type: "string" } as const;
const doc = { type: "object", properties: { in: text, text }, required: ["in", "text"] } as const;

const app = definePlugin({
  name: "app",
  // Answers keep what their writers' work drew on; notes don't.
  resources: { shared: { note: {}, answer: { drew: true } } },
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
const found = (rt: Runtime, collection: string, id: string, actor: Actor) =>
  rt.call<Doc[]>("doc.find", { collection, id }, { actor });
/** How a call failed: its code, and the place its words name. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "done",
    (e: Error & { code?: string }) => `${e.code}: ${/^That would show (\w+)/.exec(e.message)?.[1]}`,
  );

/** Ana's Personal space, where North works too: its work there, for her. */
async function personalOf(rt: Runtime): Promise<{ personal: string; mine: Actor }> {
  const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
    actor: ana,
  });
  await hire(rt, personal);
  return { personal, mine: { ...north, in: personal } };
}

each(
  "a person writes what they read wherever they may; everyone there reads it as it is",
  async (rt) => {
    await rt.call("summarize", { from: ["launch"], into: "launch", as: "answer" }, { actor: ana });
    // From Launch and Finance, into Launch: hers to show, and Bob reads it; it says nothing more.
    await rt.call("summarize", {
      id: "a2",
      from: ["launch", "finance"],
      into: "launch",
      as: "answer",
    }, { actor: ana });
    assertEquals(await answers(rt, ana), ["budget + plan", "plan"]);
    assertEquals(await answers(rt, bob), ["budget + plan", "plan"]);
    assertEquals((await found(rt, "answer", "a2", bob)).map((d) => d.drew), [undefined]);
  },
);

each(
  "an agent reads only where it works, and writes beyond that only once its person says yes",
  async (rt) => {
    // In Launch, it reads Launch alone: Finance isn't there for it.
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
    // In Ana's Personal space only she sees what's said: there it reaches all she does, and writes
    // there with nothing to ask.
    const { personal, mine } = await personalOf(rt);
    await rt.call("summarize", { from: ["launch", "finance"], into: personal, as: "answer" }, {
      actor: mine,
    });
    // (Launch's notes: Ana's, and the one it wrote there.)
    assertEquals(await answers(rt, ana), ["budget + plan + plan", "plan"]);
    assertEquals(await answers(rt, bob), ["plan"]);
    // Into Launch, what it could read there would show Bob Finance: it waits for Ana's yes, for
    // Launch itself (a yes for somewhere else is none).
    for (const approved of [undefined, ["finance"]]) {
      assertEquals(
        await refusal(
          rt.call("summarize", { from: ["launch", "finance"], into: "launch", as: "answer" }, {
            actor: { ...mine, ...(approved ? { approved } : {}) },
          }),
        ),
        "needs_approval: Launch",
      );
    }
    assertEquals(await answers(rt, bob), ["plan"]);
    // Once she's said yes, it goes: everyone in Launch reads it, Finance's budget too.
    await rt.call("summarize", { from: ["launch", "finance"], into: "launch", as: "answer" }, {
      actor: { ...mine, approved: ["launch"] },
    });
    assertEquals(await answers(rt, bob), ["budget + plan + plan", "plan"]);
  },
);

each(
  "an agent's answer says which other spaces its work read, and that keeps nobody from it",
  async (rt) => {
    const { personal, mine } = await personalOf(rt);
    // In her Personal space: Launch and Finance, both elsewhere.
    await rt.call("summarize", {
      id: "p1",
      from: ["launch", "finance"],
      into: personal,
      as: "answer",
    }, { actor: mine });
    assertEquals((await found(rt, "answer", "p1", ana)).map((d) => d.drew), [[
      "finance",
      "launch",
    ]]);
    // Written in Launch (she said yes): Bob, who can't see Finance, reads it all, and its record
    // names nothing Launch's people can't see.
    await rt.call("summarize", {
      id: "l1",
      from: ["launch", "finance"],
      into: "launch",
      as: "answer",
    }, { actor: { ...mine, approved: ["launch"] } });
    assertEquals((await found(rt, "answer", "l1", bob)).map((d) => [d.text, d.drew]), [
      ["budget + plan", undefined],
    ]);
    // From Launch itself, nothing else: it says nothing.
    await rt.call("summarize", { id: "l2", from: ["launch"], into: "launch", as: "answer" }, {
      actor: north,
    });
    assertEquals((await found(rt, "answer", "l2", bob)).map((d) => d.drew), [undefined]);
    // What doesn't keep it (a note) goes as it is: only Ana sees it, and moving it is hers to do.
    await rt.call("summarize", {
      id: "n1",
      from: ["launch", "finance"],
      into: personal,
      as: "note",
    }, {
      actor: mine,
    });
    assertEquals((await found(rt, "note", "n1", ana)).map((d) => [d.text, d.drew]), [
      ["budget + plan", undefined],
    ]);
    assertEquals(await found(rt, "note", "n1", bob), []);
  },
);
