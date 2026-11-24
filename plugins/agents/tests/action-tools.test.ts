/**
 * A tool can be an Action, by name (`tools: { add_note: { action: "note.add" } }`):
 * the model is offered it with the Action's description and input, without
 * the schema written twice, and calling it calls the Action, as the agent,
 * for its person. One that names no Action stops the runtime from starting.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  people,
  personOf,
  type Plugin,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmRequest } from "../../models/mod.ts";
import { chat } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

const notes = (tools: Record<string, unknown>, moves: unknown[], sent: LlmRequest[]): Plugin => {
  const script: LlmAdapter = {
    async *generate(request) {
      sent.push(request);
      const move = moves.shift() ?? "ok";
      if (typeof move === "string") yield { type: "text", text: move };
      else {yield {
          type: "tool_call",
          call: { id: `c${sent.length}`, ...(move as object) } as never,
        };}
    },
  };
  return definePlugin({
    name: "notes",
    collections: {
      note: defineCollection({
        schema: {
          type: "object",
          properties: { text: { type: "string" }, in: { type: "string" } },
        },
      }),
    },
    actions: {
      "note.add": defineAction({
        description: "Adds a note to this space",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        allow: people,
        run: async (ctx, { text }) => {
          const { insertedId } = await ctx.db.collection("note").insertOne({ text, in: ctx.in });
          return { note: insertedId };
        },
      }),
    },
    adapters: { llm: { s: script } },
    resources: {
      shared: { note: {} },
      provider: { s: { adapter: "s", apiKey: "k" } },
      tools,
      agents: {
        helper: {
          instructions: "Keep notes.",
          model: "s/helper",
          default: true,
          tools: ["add_note"],
        },
      },
    },
  });
};

test("a tool that is an Action: offered with its words and input, called as the agent", async () => {
  const sent: LlmRequest[] = [];
  const moves = [{ name: "add_note", input: { text: "milk" } }, "Noted."];
  const store = memoryStore();
  const rt = await createRuntime({
    store,
    plugins: [models, chat, ...access, notes({ add_note: { action: "note.add" } }, moves, sent)],
    warn: false,
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    await rt.call("chat.send", { in: space, text: "Note milk." }, { actor: { ...ana, in: space } });
    await rt.idle();
    // Offered with the Action's description and input.
    const offered = sent[0].tools?.find((t) => t.name === "add_note");
    assertEquals(offered?.description, "Adds a note to this space");
    assertEquals((offered?.input as { required: string[] }).required, ["text"]);
    // Called as the agent, for Ana, where her chat is.
    const made = (await store.events(0)).find((e) => e.type === "note.created");
    assertEquals([made?.actor?.kind, personOf(made?.actor)], ["agent", "ana"]);
    assertEquals((made?.data.doc as { text: string; in: string }).in, space);
    assert(sent.length >= 2, "the model was asked again with the tool's result");
  } finally {
    await rt.close();
  }
});

test("a tool's own description speaks for its Action; one that names no Action doesn't start", async () => {
  const sent: LlmRequest[] = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      notes({ add_note: { action: "note.add", description: "Writes down what to remember" } }, [
        "ok",
      ], sent),
    ],
    warn: false,
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    await rt.call("chat.send", { in: space, text: "Hi." }, { actor: { ...ana, in: space } });
    await rt.idle();
    const offered = sent[0].tools?.find((t) => t.name === "add_note");
    assertEquals(offered?.description, "Writes down what to remember");
  } finally {
    await rt.close();
  }
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [models, chat, ...access, notes({ add_note: { action: "note.ad" } }, [], [])],
        warn: false,
      }),
    Error,
    `is the Action "note.ad", which no plugin declares`,
  );
});
