import assert from "node:assert/strict";
import { createRuntime, defineAction, defineCollection } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

test("both Action declarations type the permission check, its context and run", () => {
  const schema = {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  } as const;
  const explicit = defineAction({
    input: schema,
    as: "check-order",
    transaction: true,
    allow: async (_actor, input, ctx) =>
      !!await ctx.db.collection("order").findOne({ code: input.code.toUpperCase() }),
    run(_ctx, input) {
      // @ts-expect-error A code is a string.
      return input.code.toFixed();
    },
  });
  const typed = defineAction({
    run(_ctx, input: { quantity: number }) {
      return input.quantity.toFixed();
    },
    allow: async (_actor, input, ctx) => {
      // @ts-expect-error There is no code in this input.
      if (input.code) return false;
      return !!await ctx.db.collection("order").findOne({ quantity: input.quantity.toFixed() });
    },
    as: "check-stock",
    transaction: true,
  });
  assert.equal(explicit.input, schema);
  assert.deepEqual(typed.input, defineAction({ run: () => 1 }).input);
});

test("a type-first collection in a hand-written plugin names the missing schema at startup", async () => {
  const order = defineCollection<{ customerId: string }>({ indexes: [["customerId"]] });
  await assert.rejects(
    createRuntime({ store: memoryStore(), plugins: [{ name: "orders", collections: { order } }] }),
    /Collection "order" has no schema: run `copilotz gen` or write `schema`/,
  );
});
