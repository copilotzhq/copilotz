/**
 * A named query may say what it answers (`description`) and what its params
 * are (`input`): a caller from outside is held to that schema, as an Action's
 * caller is to its input, and `GET /api/` and `describe()` list both. A
 * collection's `validation` is in its declaration too.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, defineCollection, definePlugin, people } from "../mod.ts";
import { describe } from "../describe.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text: { type: "string" } } },
      validation: "moderate",
      queries: {
        latest: {
          allow: people,
          description: "The latest notes, newest first",
          input: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
            required: ["limit"],
            additionalProperties: false,
          },
          run: (notes, { limit }: { limit: number }) =>
            notes.find({}, { sort: { _id: -1 }, limit: Math.min(limit, 50) }).toArray(),
        },
      },
    }),
  },
});

test("a query's input holds callers from outside to it; its words and schema are listed", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [notes, testWho] });
  try {
    assertEquals(await rt.query("note.latest", { limit: 5 }, { actor: ana }), []);
    const wrong = await assertRejects(() => rt.query("note.latest", { limit: 0 }, { actor: ana }));
    assertEquals((wrong as { code?: string }).code, "invalid");
    await assertRejects(() => rt.query("note.latest", { limit: 5, all: true }, { actor: ana }));
    // Plugin code isn't asked: it's trusted with its own reads.
    assertEquals(await rt.query("note.latest", { limit: 500 }), []);
    // The reference lists it, as it lists Actions.
    const listed = await (await rt.fetch(
      new Request("http://localhost/api/", { headers: { [TEST_ACTOR]: JSON.stringify(ana) } }),
    )).json();
    const entry = listed.queries.find((q: { name: string }) => q.name === "note.latest");
    assertEquals(entry.description, "The latest notes, newest first");
    assertEquals(entry.input.required, ["limit"]);
  } finally {
    await rt.close();
  }
});

test("describe() lists a query's words and input, and a collection's validation", async () => {
  const declared = await describe(notes);
  const note = declared.keeps.find((c) => c.name === "note")!;
  assertEquals(note.validation, "moderate");
  const latest = note.queries.find((q) => q.name === "latest")!;
  assertEquals(latest.summary, "The latest notes, newest first");
  assertEquals((latest.input as { required: string[] }).required, ["limit"]);
});
