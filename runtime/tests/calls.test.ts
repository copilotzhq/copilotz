/**
 * Calls between plugins: an unrecorded Action runs inline in its caller,
 * hands back whatever it returns (a stream too), and queries, Views and
 * startup checks may call it, read-only.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

/** A plugin others ask: what a word is in upper case, and a stream of its letters. */
const words = definePlugin({
  name: "words",
  collections: { word: { schema: { type: "object" } } },
  actions: {
    "words.upper": defineAction({
      record: false,
      input: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
      run: (_ctx, input) => input.word.toUpperCase(),
    }),
    "words.letters": defineAction({
      record: false,
      input: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
      run: async function* (_ctx, input) {
        for (const letter of input.word) yield letter;
      },
    }),
    // It writes: called from a read, it fails.
    "words.keep": defineAction({
      record: false,
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("word").insertOne({ kept: true }),
    }),
    "words.recorded": defineAction({ input: { type: "object" }, run: () => "recorded" }),
  },
  check: async (merged) => {
    if (await merged.call("words.upper", { word: "ok" }) !== "OK") throw new Error("no words");
  },
});

/** A plugin that asks: in a job, in a query and in a View. */
const asker = definePlugin({
  name: "asker",
  collections: {
    shout: {
      schema: { type: "object" },
      queries: {
        loud: (_shouts, params: { word: string }, ctx) => ctx.call("words.upper", params),
        keeps: (_shouts, _params, ctx) => ctx.call("words.keep"),
        recorded: (_shouts, _params, ctx) => ctx.call("words.recorded"),
      },
    },
  },
  actions: {
    "asker.spell": defineAction({
      input: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
      run: async (ctx, input) => {
        const letters: string[] = [];
        for await (const l of await ctx.call<AsyncIterable<string>>("words.letters", input)) {
          letters.push(l);
        }
        return letters.join("-");
      },
    }),
  },
  views: {
    loud: {
      test: (word: string, ctx: ViewContext) =>
        ctx.db.collection("shout").query<string>("loud", { word }).value,
    },
  },
});

test("an unrecorded Action runs inline and hands back a stream", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [words, asker] });
  try {
    assertEquals(await rt.call("asker.spell", { word: "abc" }), "a-b-c");
  } finally {
    await rt.close();
  }
});

test("queries and Views call unrecorded Actions, read-only", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [words, asker] });
  try {
    assertEquals(await rt.query("shout.loud", { word: "hey" }), "HEY");
    const loud = rt.observe<string>("test", "loud", "hey");
    assertEquals(await loud.ready, { status: "ready", value: "HEY" });
    loud.close();
    await assertRejects(() => rt.query("shout.keeps"), Error, "read-only");
    await assertRejects(() => rt.query("shout.recorded"), Error, "only unrecorded Actions");
  } finally {
    await rt.close();
  }
});

test("a query an Action runs knows who asks, and so do the Actions it calls", async () => {
  const who = definePlugin({
    name: "who",
    collections: {
      seen: defineCollection({
        schema: { type: "object" },
        queries: {
          asker: {
            allow: () => true,
            run: async (_seen, _params, ctx) => ({
              actor: ctx.actor?.id,
              called: await ctx.call("who.am"),
            }),
          },
        },
      }),
    },
    actions: {
      "who.am": defineAction({
        record: false,
        input: { type: "object" },
        allow: (actor) => actor.kind === "person",
        run: (ctx) => ctx.actor!.id,
      }),
      "who.asks": defineAction({
        input: { type: "object" },
        allow: () => true,
        run: async (ctx) => [
          await ctx.db.collection("seen").query("asker"),
          await ctx.transaction((tx) => tx.db.collection("seen").query("asker")),
        ],
      }),
    },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [who] });
  try {
    const ana = { kind: "person", id: "ana" } as const;
    assertEquals(await rt.call("who.asks", {}, { actor: ana }), [
      { actor: "ana", called: "ana" },
      { actor: "ana", called: "ana" },
    ]);
  } finally {
    await rt.close();
  }
});

test("a startup check asks another plugin's Actions", async () => {
  // The same plugin, answering wrong: its own check, asking, stops the runtime from starting.
  const wrong = {
    ...words,
    actions: {
      ...words.actions,
      "words.upper": defineAction({ record: false, input: { type: "object" }, run: () => "" }),
    },
  };
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: [wrong] }),
    Error,
    "words: no words",
  );
});
