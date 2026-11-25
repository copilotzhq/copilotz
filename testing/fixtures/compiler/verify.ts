import assert from "node:assert/strict";
import { createRuntime, defineAction, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { plugins } from "./app.ts";

const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins(),
    definePlugin({
      name: "test-writes",
      actions: {
        "invoice.testInsert": defineAction({
          run: (ctx) => ctx.db.collection("invoice").insertOne({ customerId: "west", quantity: 0 }),
        }),
        "invoice.testUpdate": defineAction({
          run: (ctx) => ctx.db.collection("invoice").updateOne({}, { $set: { quantity: "many" } }),
        }),
      },
    }),
  ],
});
try {
  const caller = { actor: { kind: "person", id: "buyer" } };
  const { insertedId } = await runtime.call<{ insertedId: string }>("invoice.issue", {
    customerId: "west",
    quantity: 2,
  }, caller);
  assert.deepEqual(await runtime.query("invoice.customers"), [["WEST", insertedId.toUpperCase()]]);
  const invalid = { code: "invalid", detail: { field: "quantity" } };
  await assert.rejects(runtime.call("invoice.issue", { customerId: "west", quantity: 0 }, caller), {
    ...invalid,
    message: /action "invoice.issue" input/,
  });
  // These test Actions are local to this runtime, outside the app's generated names.
  // @ts-expect-error Local test Action.
  await assert.rejects(runtime.call("invoice.testInsert"), invalid);
  // @ts-expect-error Local test Action.
  await assert.rejects(runtime.call("invoice.testUpdate"), invalid);
} finally {
  await runtime.close();
}
