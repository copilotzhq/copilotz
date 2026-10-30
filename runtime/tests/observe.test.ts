/**
 * Observing Views: output again when what they read changes, each shown View
 * a part that runs again on its own, handlers that call Actions, and
 * collections kept only in memory for state that is only live.
 */
import { assert, assertEquals } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Observed,
  type Output,
  type Runtime,
  type Store,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

type Note = { _id: string; text: string };
type Draft = { _id: string; note: string; text: string };
type Board = { notes: unknown[]; drafts: string[]; add(text: string): Promise<unknown> };

const runs: Record<string, number> = {};
const ran = (kind: string) => runs[kind] = (runs[kind] ?? 0) + 1;
const count = (kind: string) => runs[kind] ?? 0;

const text = { type: "string" } as const;
const plugin = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text }, required: ["text"] },
      queries: {
        // A read that takes a while.
        slow: async (notes) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return await notes.find({}, { sort: { _id: 1 } });
        },
      },
    }),
    like: defineCollection({
      schema: { type: "object", properties: { note: text }, required: ["note"] },
    }),
    // What someone is typing: only live, never kept.
    draft: defineCollection({
      durable: false,
      schema: { type: "object", properties: { note: text, text }, required: ["note", "text"] },
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { id: text, text }, required: ["text"] },
      run: (ctx, input) =>
        ctx.db.collection("note").insertOne({
          ...(input.id ? { _id: input.id } : {}),
          text: input.text,
        }),
    }),
    "like.add": defineAction({
      input: { type: "object", properties: { note: text }, required: ["note"] },
      run: (ctx, input) => ctx.db.collection("like").insertOne({ note: input.note }),
    }),
    "draft.set": defineAction({
      input: { type: "object", properties: { id: text, note: text, text }, required: ["id"] },
      run: (ctx, input) =>
        ctx.db.collection("draft").updateOne(
          { _id: input.id },
          { $set: { note: input.note, text: input.text } },
          { upsert: true },
        ),
    }),
    // A draft becomes its note: both in one transaction.
    "draft.save": defineAction({
      input: { type: "object", properties: { id: text }, required: ["id"] },
      run: async (ctx, input) => {
        const draft = await ctx.db.collection<Draft>("draft").findOne({ _id: input.id });
        await ctx.transaction(async (tx) => {
          await tx.db.collection("note").insertOne({ _id: draft!.note, text: draft!.text });
          await tx.db.collection("draft").deleteOne({ _id: input.id });
        });
      },
    }),
  },
  views: {
    // A board: its notes, each a part, and the drafts in progress.
    board: {
      test: (_: unknown, ctx: ViewContext): Board => {
        ran("board");
        const notes = ctx.db.collection<Note>("note").find({}, { sort: { _id: 1 } });
        const drafts = ctx.db.collection<Draft>("draft").find({}, { sort: { _id: 1 } });
        return {
          notes: (notes.value ?? []).map((n) => ctx.show("note", n)),
          drafts: (drafts.value ?? []).map((d) => d.text),
          add: (text: string) => ctx.call("note.add", { text, id: text }),
        };
      },
    },
    // A note and its likes, which only it reads.
    note: {
      test: (n: Note, ctx: ViewContext) => {
        ran(`note:${n._id}`);
        const likes = ctx.db.collection("like").countDocuments({ note: n._id });
        return `${n.text} (${likes.value ?? 0})`;
      },
    },
    // The drafts alone; the notes alone, slowly.
    drafts: {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<Draft>("draft").find({}).value ?? []).map((d) => d.text),
    },
    "slow notes": {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<Note>("note").query<Note[]>("slow", {}).value ?? []).map((n) => n.text),
    },
    broken: {
      test: () => {
        throw new Error("no luck");
      },
    },
    shelf: {
      test: (_: unknown, ctx: ViewContext) => [
        ctx.show("broken", {}),
        ctx.show("note", { _id: "n0", text: "fine" }),
      ],
    },
  },
});

/** A part as this medium places it: a box holding the part. */
const parts = { part: (part: Observed) => ({ part }) };

/** What an output shows, as plain data: parts by their own outputs, all the way down. */
const plain = (value: unknown): unknown => {
  if (value && typeof value === "object" && "part" in value) {
    const out = (value as { part: Observed }).part.get();
    return out.status === "ready" ? plain(out.value) : out.status;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => typeof v !== "function").map((
        [k, v],
      ) => [k, plain(v)]),
    );
  }
  return value;
};
const shown = <R>(out: Output<R>) =>
  out.status === "ready" ? plain(out.value) : out.status === "failed" ? out.error : "loading";

/** Resolves once what `observed` shows passes `check`. */
const until = <R>(observed: Observed<R>, check: (shows: unknown) => boolean) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Still showing ${JSON.stringify(shown(observed.get()))}`)),
      5000,
    );
    const look = () => {
      if (!check(shown(observed.get()))) return;
      clearTimeout(timer);
      off();
      resolve();
    };
    const off = observed.subscribe(look);
    look();
  });

/** Lets anything due run, then a little more. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

const each = (name: string, fn: (runtime: Runtime, store: Store) => Promise<void>) => {
  for (const [kind, make] of Object.entries(stores)) {
    test(`${kind}: ${name}`, async () => {
      for (const key of Object.keys(runs)) delete runs[key];
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

each("what one commit changes shows at once: never both, nor neither", async (rt) => {
  await rt.call("draft.set", { id: "d1", note: "n1", text: "hello" });
  const drafts = rt.observe<string[]>("test", "drafts", {});
  const notes = rt.observe<string[]>("test", "slow notes", {});
  await Promise.all([drafts.ready, notes.ready]);
  // What both show, each time either tells something new.
  const seen: string[] = [];
  const look = () => {
    const [d, n] = [drafts.get(), notes.get()];
    if (d.status === "ready" && n.status === "ready") seen.push(`${d.value}|${n.value}`);
  };
  const offs = [drafts.subscribe(look), notes.subscribe(look)];
  // The draft becomes its note in one commit; the notes take a while to read.
  await rt.call("draft.save", { id: "d1" });
  await until(notes, (s) => (s as string[]).length === 1);
  await settle();
  for (const off of offs) off();
  assertEquals([...new Set(seen)], ["|hello"]);
  drafts.close();
  notes.close();
});

each("a View's output comes again when what it read changes; a part runs alone", async (rt) => {
  await rt.call("note.add", { id: "a", text: "a" });
  const board = rt.observe<Board>("test", "board", {}, parts);
  assertEquals(shown(await board.ready), { notes: ["a (0)"], drafts: [] });

  // A like only "a"'s part reads: that part runs again, in one pass (what
  // it read last time is in again first); the board doesn't run.
  const [boards, a] = [count("board"), count("note:a")];
  await rt.call("like.add", { note: "a" });
  await until(board, (s) => (s as Board).notes[0] === "a (1)");
  assertEquals([count("board") - boards, count("note:a") - a], [0, 1]);

  // A handler calls an Action. The new note comes in as a part of its own,
  // and "a", shown again unchanged, keeps its output without running.
  const out = board.get();
  assert(out.status === "ready");
  await out.value.add("b");
  await until(board, (s) => (s as Board).notes.length === 2);
  assertEquals(shown(board.get()), { notes: ["a (1)", "b (0)"], drafts: [] });
  assertEquals(count("note:a") - a, 1);
  assert(count("note:b") > 0);
  board.close();
});

each(
  "a collection kept in memory: live state, swapped for what it became at once",
  async (rt, store) => {
    const board = rt.observe<Board>("test", "board", {}, parts);
    await board.ready;
    await rt.call("draft.set", { id: "d", note: "n", text: "half writ" });
    await until(board, (s) => (s as Board).drafts[0] === "half writ");
    await rt.call("draft.set", { id: "d", note: "n", text: "written" });
    await until(board, (s) => (s as Board).drafts[0] === "written");

    // Saved, the draft goes as its note comes: no output shows both, or neither.
    const seen: unknown[] = [];
    const off = board.subscribe(() => seen.push(shown(board.get())));
    await rt.call("draft.save", { id: "d" });
    await until(board, (s) => (s as Board).notes.length === 1);
    off();
    for (const s of seen as Board[]) {
      assertEquals(s.notes.length + s.drafts.length, 1, JSON.stringify(seen));
    }
    assertEquals(shown(board.get()), { notes: ["written (0)"], drafts: [] });

    // It records no events, and the store never held it.
    const events = await store.events(0, 1000);
    assertEquals(events.filter((e) => e.type.startsWith("draft.")), []);
    assert(events.some((e) => e.type === "note.created"));
    board.close();
  },
);

each("a part that fails shows why, and its parent still shows", async (rt) => {
  const shelf = rt.observe("test", "shelf", {}, parts);
  const out = await shelf.ready;
  assert(out.status === "ready");
  const [broken, fine] = out.value as { part: Observed }[];
  const failed = broken.part.get();
  assert(failed.status === "failed");
  assertEquals((failed.error as Error).message, "no luck");
  assertEquals(shown(fine.part.get()), "fine (0)");
  shelf.close();
});

each("without parts, shown Views render inline, and the whole runs again", async (rt) => {
  await rt.call("note.add", { id: "a", text: "a" });
  const board = rt.observe<Board>("test", "board", {});
  assertEquals(shown(await board.ready), { notes: ["a (0)"], drafts: [] });
  const boards = count("board");
  await rt.call("like.add", { note: "a" });
  await until(board, (s) => (s as Board).notes[0] === "a (1)");
  assert(count("board") > boards);
  board.close();
});

each("closed, an observation runs no more", async (rt) => {
  await rt.call("note.add", { id: "a", text: "a" });
  const board = rt.observe<Board>("test", "board", {}, parts);
  await board.ready;
  board.close();
  const [boards, notes] = [count("board"), count("note:a")];
  await rt.call("like.add", { note: "a" });
  await rt.call("note.add", { id: "b", text: "b" });
  await settle();
  assertEquals([count("board"), count("note:a"), count("note:b")], [boards, notes, 0]);
});
