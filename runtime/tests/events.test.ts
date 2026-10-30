/**
 * Declared events: a plugin says what it emits, beyond its collections'
 * changes and its Actions' lifecycle. Emitting an undeclared type fails, so
 * does data unlike what's declared, and from outside only an actor the
 * event lets emit it may.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../mod.ts";
import { merge } from "../registry.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

const bell = definePlugin({
  name: "bell",
  collections: {
    ring: { schema: { type: "object" }, queries: { all: (rings) => rings.find({}) } },
  },
  events: {
    "bell.rang": {
      schema: { type: "object", properties: { times: { type: "integer" } }, required: ["times"] },
    },
    // A person may ring it from outside (a key press in a View).
    "bell.pressed": { schema: { type: "object" }, allow: (actor) => actor.kind === "person" },
  },
  actions: {
    "bell.ring": defineAction({
      input: { type: "object" },
      run: async (ctx, input) => {
        await ctx.emit(String(input.type ?? "bell.rang"), input.data as Record<string, unknown>);
      },
    }),
    "bell.ring.later": defineAction({
      input: { type: "object" },
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          tx.emit(String(input.type), input.data as Record<string, unknown>);
          await tx.db.collection("ring").insertOne({});
        }),
    }),
  },
});

test("an emitted event is declared, and its data is as declared", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [bell] });
  try {
    await rt.call("bell.ring", { data: { times: 2 } });
    await assertRejects(
      () => rt.call("bell.ring", { type: "bell.fell", data: {} }),
      Error,
      'Undeclared event "bell.fell"',
    );
    await assertRejects(
      () => rt.call("bell.ring", { data: { times: "two" } }),
      Error,
      'event "bell.rang"',
    );
    // In a transaction too: refused before anything is written.
    await assertRejects(
      () => rt.call("bell.ring.later", { type: "bell.fell", data: {} }),
      Error,
      "Undeclared event",
    );
    assertEquals(await rt.query("ring.all"), []);
  } finally {
    await rt.close();
  }
});

test("from outside, an actor emits only what lets them; the system emits any declared event", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [bell] });
  try {
    await rt.emit("bell.pressed", {}, { actor: ana });
    await assertRejects(
      () => rt.emit("bell.rang", { times: 1 }, { actor: ana }),
      Error,
      "may not emit",
    );
    await rt.emit("bell.rang", { times: 1 });
    await assertRejects(() => rt.emit("bell.fell", {}), Error, "Undeclared event");
  } finally {
    await rt.close();
  }
});

test("the runtime's own events can't be declared", () => {
  const own = (type: string) =>
    definePlugin({
      name: "own",
      collections: { ring: { schema: { type: "object" } } },
      events: { [type]: { schema: { type: "object" } } },
    });
  assertThrows(() => merge([own("ring.created")]), Error, "the runtime's own");
  assertThrows(() => merge([own("action.completed")]), Error, "the runtime's own");
  assertThrows(() => merge([own("processor.failed")]), Error, "the runtime's own");
  assertEquals(Object.keys(merge([own("ring.polished")]).events), ["ring.polished"]);
});
