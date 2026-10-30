/**
 * Views: data presented to a medium. Registered by kind and renderer, composed
 * with `ctx.show`, relative to a viewer, overridden by later plugins, and
 * reading synchronously while the renderer runs them until nothing is pending.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Plugin,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

type Note = { _id: string; text: string; author: string; next?: string };

let passes = 0;

const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          author: { type: "string" },
          next: { type: "string" },
        },
        required: ["text", "author"],
      },
      queries: {
        // Renders through a query, so clients can see what a View makes.
        render: (
          _notes,
          p: { renderer: string; kind: string; item: unknown; viewer?: string },
          ctx,
        ) =>
          ctx.render(p.renderer, p.kind, p.item, {
            ...(p.viewer ? { viewer: { name: p.viewer } } : {}),
            hints: { mode: "line" },
          }),
        first: (notes) => notes.findOne({}, { sort: { text: 1 } }),
      },
    }),
  },
  views: {
    note: {
      llm: (n: Note, ctx: ViewContext) =>
        `${n.author === ctx.viewer?.name ? "you" : n.author}: ${n.text}` +
        (ctx.hints.mode === "line" ? "" : " (full)"),
      html: (n: Note) => `<p>${n.text}</p>`,
    },
    // Reads that depend on reads: the list, then the note each one points to.
    board: {
      llm: (_item: unknown, ctx: ViewContext) => {
        passes++;
        const all = ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } });
        if (all.status !== "ready") return "…";
        return all.value.map((n) => {
          const next = n.next
            ? ctx.db.collection<Note>("note").findOne({ _id: n.next })
            : undefined;
          const after = next?.status === "ready" && next.value ? ` → ${next.value.text}` : "";
          return `${ctx.show("note", n, { mode: "line" })}${after}`;
        }).join("\n");
      },
    },
    first: {
      llm: (_item: unknown, ctx: ViewContext) => {
        const first = ctx.db.collection<Note>("note").query<Note | null>("first");
        return first.status === "ready" ? ctx.show("note", first.value) : "…";
      },
    },
    restless: {
      // A new read every pass: never settles.
      llm: (_item: unknown, ctx: ViewContext) =>
        ctx.db.collection("note").find({ text: crypto.randomUUID() }).status,
    },
    broken: {
      llm: (_item: unknown, ctx: ViewContext) =>
        ctx.db.collection("note").find({ text: { $regex: "x" } }).status,
    },
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object" },
      run: (ctx, input) => ctx.db.collection("note").insertOne(input as Note),
    }),
    // Plugin code renders too.
    "note.board": defineAction({
      input: { type: "object" },
      record: false,
      run: (ctx) => ctx.render("llm", "board", null),
    }),
  },
});

async function start(...more: Plugin[]) {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [notes, ...more] });
  const render = (renderer: string, kind: string, item: unknown, viewer?: string) =>
    runtime.query("note.render", { renderer, kind, item, viewer });
  return { runtime, render };
}

test("a View presents its kind for a renderer, relative to the viewer", async () => {
  const { runtime, render } = await start();
  const note = { _id: "a", text: "hello", author: "ana" };
  assertEquals(await render("llm", "note", note, "bob"), "ana: hello");
  assertEquals(await render("llm", "note", note, "ana"), "you: hello");
  assertEquals(await render("html", "note", note), "<p>hello</p>");
  // No View for this kind, or for this renderer: nothing.
  assertEquals(await render("llm", "nothing", note), undefined);
  assertEquals(await render("react", "note", note), undefined);
  await runtime.close();
});

test("reads settle: the renderer runs a View again until it reads nothing new", async () => {
  const { runtime } = await start();
  await runtime.call("note.add", { _id: "a", text: "first", author: "ana", next: "b" });
  await runtime.call("note.add", { _id: "b", text: "second", author: "bob" });
  passes = 0;
  assertEquals(await runtime.call("note.board", {}), "ana: first → second\nbob: second");
  // The list, then the note it points to, then a pass that reads nothing new.
  assertEquals(passes, 3);
  // Queries are reads too.
  assertEquals(
    await runtime.query("note.render", { renderer: "llm", kind: "first", item: null }),
    "ana: first (full)",
  );
  await runtime.close();
});

test("a View that never settles, or whose read fails, fails its render", async () => {
  const { runtime, render } = await start();
  await assertRejects(() => render("llm", "restless", null), Error, "kept making new reads");
  await assertRejects(() => render("llm", "broken", null), Error, "Unsupported filter operator");
  await runtime.close();
});

test("the last plugin's View wins, for its kind and renderer only", async () => {
  const app = definePlugin({
    name: "app",
    views: { note: { llm: (n: Note) => `[${n.author}] ${n.text}` } },
  });
  const { runtime, render } = await start(app);
  const note = { _id: "a", text: "hello", author: "ana" };
  assertEquals(await render("llm", "note", note), "[ana] hello");
  assertEquals(await render("html", "note", note), "<p>hello</p>");
  await runtime.close();
});
