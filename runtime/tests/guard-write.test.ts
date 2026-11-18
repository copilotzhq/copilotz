/**
 * A guard is told which write it's asked about (an insert, an update, a
 * replacement or a delete), so a rule can let people add and change a
 * collection's documents but not delete them, from outside and in code.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  byCollection,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  failure,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const told: string[] = [];

const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    }),
  },
  // People add and change notes; only the app deletes them.
  guard: (actor, { collection, write }) => {
    if (collection !== "note" || actor.kind !== "person") return undefined;
    if (write) told.push(write);
    if (write === "delete") throw failure("forbidden", "Notes aren't deleted.", { public: true });
    return true;
  },
  actions: {
    "note.drop": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      allow: () => true,
      run: (ctx, { id }) => ctx.db.collection("note").deleteOne({ _id: id }),
    }),
  },
});

test("a guard knows an insert from an update, a replacement and a delete", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [notes, testWho] });
  const as = (method: string, path: string, body?: unknown) =>
    rt.fetch(
      new Request(`http://localhost/api/collections/note${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { "content-type": "application/json", [TEST_ACTOR]: JSON.stringify(ana) },
      }),
    );
  try {
    const made = await as("POST", "", { _id: "n1", text: "a" });
    assertEquals(made.status, 201);
    assertEquals((await as("PATCH", "/n1", { text: "b" })).status, 200);
    assertEquals((await as("PUT", "/n1", { text: "c" })).status, 200);
    const gone = await as("DELETE", "/n1");
    assertEquals(gone.status, 403);
    assertEquals((await gone.json()).error.message, "Notes aren't deleted.");
    // In code, for her, the same.
    await assertRejects(() => rt.call("note.drop", { id: "n1" }, { actor: ana }), Error, "deleted");
    for (const write of ["insert", "update", "replace", "delete"]) {
      assertEquals(told.includes(write), true, write);
    }
  } finally {
    await rt.close();
  }
});

test("byCollection: each collection's rule, and none for any other", async () => {
  const guard = byCollection({
    note: (_actor, { write }) => (write === "delete" ? { never: true } : true),
    tag: () => ({ mine: true }),
  });
  const ctx = {} as Parameters<typeof guard>[2];
  assertEquals(
    await guard(ana, { collection: "note", access: "write", write: "insert" }, ctx),
    true,
  );
  assertEquals(await guard(ana, { collection: "note", access: "write", write: "delete" }, ctx), {
    never: true,
  });
  assertEquals(await guard(ana, { collection: "tag", access: "read" }, ctx), { mine: true });
  assertEquals(await guard(ana, { collection: "other", access: "read" }, ctx), undefined);
  // Not one of Object's own names either.
  assertEquals(await guard(ana, { collection: "toString", access: "read" }, ctx), undefined);
});
