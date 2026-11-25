import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  type AllowContext,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  inPerson,
  people,
  personOf,
} from "../mod.ts";
import { READ_VIEW } from "../browsers.ts";
import { describe } from "../describe.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

const ana = { kind: "person", id: "ana", in: "shop" };
const bob = { ...ana, id: "bob" };
const contact = { kind: "contact", id: "visitor" };

const canUse = (module: string) => async (actor: Actor, _: unknown, ctx: AllowContext) =>
  people(actor) && !!await ctx.db.collection("permission").findOne({ module });

const inventory = definePlugin({
  name: "inventory",
  defaults: { allow: canUse("inventory") },
  guard: (actor, { collection, access }) => {
    if (collection === "permission") return { owner: personOf(actor) };
    if (collection === "badge") return { owner: actor.id };
    if (collection === "product" && access === "write") return { _id: { $in: [] } };
  },
  collections: {
    badge: { schema: { type: "object", properties: { owner: { type: "string" } } } },
    permission: {
      schema: {
        type: "object",
        properties: { module: { type: "string" }, owner: { type: "string" } },
      },
    },
    product: defineCollection({
      schema: { type: "object", properties: { stock: { type: "integer" } } },
      queries: {
        count: (products) => products.countDocuments({}),
        listed: {
          description: "How many products",
          run: (products) => products.countDocuments({}),
        },
        person: { allow: inPerson, run: () => true },
        review: { allow: people, run: (_c, _p, ctx) => ctx.call("stock.review") },
      },
    }),
    receipt: {
      records: true,
      schema: { type: "object", properties: { stock: { type: "integer" } } },
    },
  },
  actions: {
    "stock.permit": defineAction({
      allow: () => false,
      run: (ctx) =>
        ctx.db.collection("permission").insertOne({ owner: "ana", module: "inventory" }),
    }),
    "stock.badge": defineAction({
      allow: () => false,
      run: (ctx) => ctx.db.collection("badge").insertMany([{ owner: "helper" }, { owner: "ana" }]),
    }),
    "stock.revoke": defineAction({
      allow: () => false,
      run: (ctx) => ctx.db.collection("permission").deleteMany({}),
    }),
    "stock.review": defineAction({ record: false, as: "review", run: (ctx) => ctx.actor?.id }),
    "stock.add": defineAction({
      as: "stock-add",
      run: (ctx) => ctx.db.collection("product").insertOne({ _id: "p", stock: 1 }),
    }),
    "stock.adjust": defineAction({
      as: "stock-adjust",
      transaction: true,
      input: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                by: { type: "integer" },
              },
              required: ["id", "by"],
              additionalProperties: false,
            },
          },
          cancel: { type: "boolean" },
        },
        required: ["changes"],
        additionalProperties: false,
      },
      run: async (ctx, input) => {
        // @ts-expect-error The declared array has no such method.
        if (false) input.changes.toUpperCase();
        for (const change of input.changes) {
          // @ts-expect-error Only id and by are declared on a change.
          if (false) change.amount;
          await ctx.db.collection("product").updateOne({ _id: change.id }, {
            $inc: { stock: change.by },
          });
          ctx.record("receipt", { stock: change.by });
        }
        if (input.cancel) throw new Error("Adjustment cancelled");
        return ctx.actor;
      },
    }),
    "stock.delegate": defineAction({
      allow: async (_actor, _, ctx) => !!await ctx.db.collection("badge").countDocuments({}),
      run: () => true,
    }),
    "stock.cancel": defineAction({
      allow: inPerson,
      transaction: true,
      run: async (ctx) => {
        await ctx.call("stock.adjust", { changes: [{ id: "p", by: 20 }] });
        throw new Error("Order cancelled");
      },
    }),
    "stock.trial": defineAction({
      allow: inPerson,
      transaction: true,
      run: async (ctx) => {
        await ctx.db.collection("permission").insertOne({
          owner: ctx.actor!.id,
          module: "inventory",
        });
        return await ctx.call("stock.adjust", { changes: [] });
      },
    }),
  },
});

test("the plugin declaration describes inherited and database-backed admission", async () => {
  const declaration = await describe(inventory);
  const add = declaration.actions.find((a) => a.name === "stock.add");
  assertEquals(add?.callers?.person, "some");
  assertEquals(
    declaration.keeps.find((c) => c.name === "product")?.queries.find((q) => q.name === "count")
      ?.callers?.person,
    "some",
  );
  assertEquals(declaration.actions.find((a) => a.name === "stock.cancel")?.helper, "inPerson");
});

test("a watched query follows the permission it read and refuses after revocation", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [inventory] });
  try {
    await runtime.call("stock.permit");
    const observation = runtime.observe(READ_VIEW, { collection: "product", query: "count" }, {
      actor: ana,
    });
    try {
      assertEquals(await observation.ready, { status: "ready", value: 0 });
      await runtime.call("stock.revoke");
      await runtime.idle();
      const denied = observation.get();
      assert(denied.status === "failed");
      assertEquals((denied.error as { code: string }).code, "forbidden");
    } finally {
      observation.close();
    }
  } finally {
    await runtime.close();
  }
});

for (
  const [kind, make] of Object.entries({
    memory: memoryStore,
    sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
    pglite: () => postgresStore({ url: ":memory:" }),
  })
) {
  test(`${kind}: permissions, a named grant and one transaction for the Action`, async () => {
    const store = await make();
    const runtime = await createRuntime({ store, plugins: [inventory] });
    try {
      await runtime.call("stock.permit");
      await assertRejects(
        () => runtime.call("stock.permit", {}, { actor: ana }),
        Error,
        "may not call",
      );
      for (const actor of [bob, contact, { kind: "agent", id: "helper", for: contact }]) {
        await assertRejects(() => runtime.call("stock.add", {}, { actor }), Error, "may not call");
        for (const query of ["count", "listed"]) {
          await assertRejects(
            () => runtime.query("product." + query, {}, { actor }),
            Error,
            "may not run",
          );
        }
      }
      await runtime.call("stock.badge");
      const agent = { kind: "agent", id: "helper", for: bob };
      await assertRejects(
        () => runtime.call("stock.delegate", {}, { actor: agent }),
        Error,
        "may not call",
      );
      assertEquals(
        await runtime.call("stock.delegate", {}, { actor: { ...agent, for: ana } }),
        true,
      );
      assertEquals(await runtime.query("product.person", {}, { actor: bob }), true);
      for (const input of [{ extra: true }, [], null]) {
        const refused = await assertRejects(() => runtime.call("stock.add", input, { actor: ana }));
        assertEquals((refused as { code: string }).code, "invalid");
      }
      await runtime.call("stock.add", undefined, { actor: ana });
      assertEquals(await runtime.query("product.count", {}, { actor: ana }), 1);
      assertEquals(await runtime.query("product.listed", {}, { actor: ana }), 1);
      assertEquals(await runtime.query("product.review", {}, { actor: ana }), "review");
      await assertRejects(
        () => runtime.query("product.review", {}, { actor: bob }),
        Error,
        "may not call",
      );
      const changes = [{ id: "p", by: 3 }];
      await assertRejects(
        () => runtime.call("stock.adjust", { changes, cancel: true }, { actor: ana }),
        Error,
        "Adjustment cancelled",
      );
      await assertRejects(
        () => runtime.call("stock.cancel", {}, { actor: ana }),
        Error,
        "Order cancelled",
      );
      assert(!(await store.events(0)).some((e) => e.type === "product.updated"));
      const elevated = await runtime.call("stock.adjust", { changes }, {
        actor: ana,
        id: "adjust-once",
      });
      assertEquals(elevated, { kind: "system", id: "stock-adjust", via: ana, in: "shop" });
      assertEquals(
        await runtime.call("stock.adjust", { changes }, { actor: ana, id: "adjust-once" }),
        elevated,
      );
      const log = await store.events(0);
      const writes = log.filter((e) => e.type === "product.updated");
      assertEquals(writes.length, 1);
      assertEquals(writes[0].data.doc, { _id: "p", stock: 4 });
      assertEquals(writes[0].actor, elevated);
      assertEquals(writes[0].cause, "adjust-once");
      assertEquals(log.find((e) => e.id === "adjust-once")?.actor, ana);
      assertEquals(log.find((e) => e.type === "product.created")?.actor, {
        kind: "system",
        id: "stock-add",
        via: ana,
        in: "shop",
      });
      assertEquals((await store.find("receipt", {})).length, 1);
      // The permission check of a joined Action sees its caller's uncommitted write.
      assertEquals(await runtime.call("stock.trial", {}, { actor: bob }), {
        kind: "system",
        id: "stock-adjust",
        via: bob,
        in: "shop",
      });
    } finally {
      await runtime.close();
    }
  });
}
