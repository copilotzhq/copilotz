/**
 * Quotes: what a use would be charged now, rated as a recorded one is (its
 * cost and the price book's margin), and recorded nowhere. People see the
 * price; platform staff the cost too.
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import usage from "../usage/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const staff: Actor = { kind: "person", id: "sam", staff: true };

test("a quote prices a use by the books in force, without recording it", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      usage,
      definePlugin({
        name: "books",
        resources: {
          cost: {
            "cloud/small": { seconds: 0.0385, per: 3600 },
            "cloud/disk": { gbHours: 0.10 / 730, per: 1 },
          },
          price: { "cloud/*": { margin: 0.9 }, "cloud/disk": { margin: 0.5 } },
        },
      }),
    ],
  });
  try {
    const hour = { meter: "computer", subject: "cloud/small", quantities: { seconds: 3600 } };
    const priced = await runtime.call<{ price: number; cost?: number }>("usage.quote", hour, {
      actor: ana,
    });
    assertAlmostEquals(priced.price, 0.385, 1e-9);
    assertEquals(priced.cost, undefined, "people see prices, not costs");
    const told = await runtime.call<{ price: number; cost: number }>("usage.quote", hour, {
      actor: staff,
    });
    assertAlmostEquals(told.cost, 0.0385, 1e-9);
    const month = await runtime.call<{ price: number }>("usage.quote", {
      meter: "computer",
      subject: "cloud/disk",
      quantities: { gbHours: 730 },
    }, { actor: ana });
    assertAlmostEquals(month.price, 0.2, 1e-9);
    // Nothing prices it: null.
    assertEquals(
      await runtime.call("usage.quote", {
        meter: "computer",
        subject: "cloud/huge",
        quantities: { seconds: 1 },
      }, { actor: ana }),
      { price: null },
    );
    assertEquals(await runtime.query("usage.list", {}), []);
  } finally {
    await runtime.close();
  }
});
