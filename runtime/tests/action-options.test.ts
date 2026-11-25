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
  type TransactionScope,
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

  test(`${kind}: durable and temporary writes roll back together`, async () => {
    const store = await make();
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "invoicing",
        collections: {
          invoice: { schema: { type: "object", properties: { note: { type: "string" } } } },
          draft: {
            durable: false,
            schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
          },
        },
        actions: {
          issue: defineAction({
            transaction: true,
            run: async (ctx) => {
              await ctx.db.collection("invoice").insertOne({});
              await ctx.db.collection("draft").insertOne({});
            },
          }),
          save: defineAction({
            run: (ctx) =>
              ctx.transaction(async (tx) => {
                await tx.db.collection("invoice").insertOne({});
                await tx.db.collection("invoice").countDocuments({});
                await tx.db.collection("draft").insertOne({});
              }),
          }),
          reverse: defineAction({
            transaction: true,
            run: async (ctx) => {
              await ctx.db.collection("draft").insertOne({ n: 2 });
              await ctx.db.collection("invoice").insertOne({ note: 3 });
            },
          }),
          valid: defineAction({
            transaction: true,
            run: async (ctx) => {
              await ctx.db.collection("invoice").insertOne({});
              await ctx.db.collection("draft").insertOne({ n: 1 });
              return ctx.db.collection("draft").countDocuments({});
            },
          }),
        },
      }],
    });
    try {
      for (const action of ["issue", "save"]) {
        for (let i = 0; i < 2; i++) {
          await assertRejects(() => runtime.call(action, {}, { id: action }), Error, "draft");
          assertEquals(await store.find("invoice", {}), []);
        }
        const log = (await store.events(0)).filter((e) => e.cause === action);
        assertEquals(log.filter((e) => e.type === "action.failed").length, 2);
        assertEquals(log.filter((e) => e.type === "action.completed").length, 0);
      }
      await assertRejects(() => runtime.call("reverse"), Error, "invoice");
      assertEquals(await runtime.call("valid"), 1);
      assertEquals((await store.find("invoice", {})).length, 1);
    } finally {
      await runtime.close();
    }
  });

  for (const rule of ["sync", "async"]) {
    test(`${kind}: ${rule} permission changes on retry keep the later sale's receipt`, async () => {
      const store = await make();
      let allowed = true;
      const allow = rule === "sync" ? () => allowed : async () => allowed;
      const runtime = await createRuntime({
        store,
        plugins: [{
          name: "sales",
          collections: {
            sale: { schema: { type: "object", properties: { note: { type: "string" } } } },
          },
          actions: {
            check: defineAction({ atomic: true, allow, run: () => true }),
            review: defineAction({
              atomic: true,
              record: false,
              allow,
              run: (ctx) => ctx.call("check"),
            }),
            sell: defineAction({
              transaction: true,
              run: async (ctx) => (await ctx.db.collection("sale").insertOne({})).insertedId,
            }),
            parent: defineAction({
              allow: people,
              input: {
                type: "object",
                properties: { joined: { type: "boolean" }, check: { type: "string" } },
                required: ["joined", "check"],
              },
              run: async (ctx, { joined, check }) => {
                const sellAfterCheck = async (scope: Pick<TransactionScope, "call">) => {
                  if (allowed) assertEquals(await scope.call(check), true);
                  else await assertRejects(() => scope.call(check), Error, "may not call");
                  return scope.call("sell");
                };
                const sale = joined
                  ? await ctx.transaction(sellAfterCheck)
                  : await sellAfterCheck(ctx);
                if (!ctx.retry) throw new Error("after the sale");
                return sale;
              },
            }),
          },
        }],
      });
      try {
        for (const joined of [false, true]) {
          for (const check of ["check", "review"]) {
            const options = { id: `${joined}-${check}`, actor: ana };
            const input = { joined, check };
            allowed = true;
            await assertRejects(
              () => runtime.call("parent", input, options),
              Error,
              "after the sale",
            );
            const sales = await store.count("sale", {});
            const started = (await store.related(options.id, ["action.started"]))
              .find((e) => e.data.action === "sell");
            assert(started);
            const [receipt] = await store.related(started.id, ["action.completed"]);
            allowed = false;
            const sale = await runtime.call("parent", input, options);
            assertEquals(sale, receipt.data.result);
            assertEquals(await store.count("sale", {}), sales);
          }
        }
      } finally {
        await runtime.close();
      }
    });
  }

  test(`${kind}: retries reconcile rc.63 child receipts after synchronous permission checks`, async () => {
    let allowed = false;
    let checks = 0;
    const store = await make();
    // Receipts in rc.63's format, seeded before opening the upgraded runtime. Each parent failed after
    // its first admitted child had committed. Hashes include the Action name and input.
    const { epoch } = await store.open();
    await store.transaction(epoch, async (tx) => {
      for (
        const [id, action, inputHash, position] of [
          ["parent", "parent", "b888483fe9979b4c", 1],
          ["joined", "joined", "fb601e5df447c520", 1],
          ["parent-changed", "parent", "b888483fe9979b4c", 1],
          ["joined-changed", "joined", "fb601e5df447c520", 1],
          ["parent-gap", "parent", "b888483fe9979b4c", 2],
        ] as const
      ) {
        const child = `${id}.${position}.a67be582be756679`;
        tx.emit({
          id,
          type: "action.started",
          actor: ana,
          data: { action, input: {}, inputHash, attempt: 1 },
        });
        tx.emit({
          id: child,
          cause: id,
          type: "action.started",
          actor: ana,
          data: { action: "sell", input: {}, inputHash: "a67be582be756679", attempt: 1 },
        });
        await tx.insert("sale", [{ _id: id }]);
        tx.emit({
          cause: child,
          type: "action.completed",
          actor: ana,
          data: { action: "sell", result: { acknowledged: true, insertedId: id }, attempt: 1 },
        });
        tx.emit({ cause: id, type: "action.failed", actor: ana, data: { action, attempt: 1 } });
      }
    });
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "sales",
        collections: {
          sale: { schema: { type: "object", properties: { note: { type: "string" } } } },
        },
        actions: {
          denied: defineAction({ atomic: true, allow: () => allowed, run: () => ++checks }),
          sell: defineAction({
            atomic: true,
            allow: people,
            run: (ctx) => ctx.db.collection("sale").insertOne({}),
          }),
          parent: defineAction({
            allow: people,
            run: async (ctx) => {
              await ctx.call("denied", {}).catch(() => {});
              return ctx.call("sell", {});
            },
          }),
          joined: defineAction({
            allow: people,
            run: (ctx) =>
              ctx.transaction(async (tx) => {
                await tx.call("denied", {}).catch(() => {});
                return tx.call("sell", {});
              }),
          }),
        },
      }],
    });
    try {
      for (const id of ["parent", "joined"]) {
        assertEquals(await runtime.call(id, {}, { id, actor: ana }), {
          acknowledged: true,
          insertedId: id,
        });
      }
      await assertRejects(
        () => runtime.call("parent", {}, { id: "parent-gap", actor: ana }),
        Error,
        '"parent-gap" at position 1',
      );
      allowed = true;
      for (const action of ["parent", "joined"]) {
        const id = action + "-changed";
        await assertRejects(
          () => runtime.call(action, {}, { id, actor: ana }),
          Error,
          `"${id}" at position 1`,
        );
        assertEquals(await store.related(id, ["action.completed"]), []);
      }
      assertEquals(checks, 0);
      assertEquals(await store.count("sale", {}), 5);
    } finally {
      await runtime.close();
    }
  });
  test(`${kind}: a recovered Processor delivery keeps the numbering it began with`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    const child = "old.1.a67be582be756679";
    await store.transaction(epoch, async (tx) => {
      tx.emit({ id: "old", type: "order.placed", actor: ana, data: {} });
      tx.emit({
        id: child,
        cause: "old",
        type: "action.started",
        actor: ana,
        data: { action: "sell", input: {}, inputHash: "a67be582be756679", attempt: 1 },
      });
      await tx.insert("sale", [{ _id: "previous-sale" }]);
      tx.emit({
        cause: child,
        type: "action.completed",
        actor: ana,
        data: { action: "sell", result: "previous-sale", attempt: 1 },
      });
    });

    const sales: string[] = [];
    const sold = Promise.withResolvers<void>();
    let allowed = false;
    const plugin = definePlugin({
      name: "sales",
      collections: {
        sale: { schema: { type: "object", properties: { note: { type: "string" } } } },
      },
      events: { "order.placed": { schema: { type: "object" }, allow: people } },
      actions: {
        check: defineAction({ allow: () => allowed, run: () => true }),
        sell: defineAction({
          run: async (ctx) => (await ctx.db.collection("sale").insertOne({})).insertedId,
        }),
      },
      processors: {
        orders: {
          on: "order.placed",
          run: async (ctx) => {
            await ctx.call("check", {}).catch(() => {});
            sales.push(await ctx.call("sell", {}));
            if (!ctx.retry) {
              sold.resolve();
              await new Promise<void>((done) =>
                ctx.signal.addEventListener("abort", () => done(), { once: true })
              );
            }
          },
        },
      },
    });
    // Keep the database across the owner's restart, including in-memory PGlite.
    const first = await createRuntime({
      store: { ...store, close: async () => {} },
      plugins: [plugin],
    });
    try {
      await first.idle();
      assertEquals(sales, ["previous-sale"]);
      await first.emit("order.placed", {}, { id: "new", actor: ana });
      await Promise.race([sold.promise, first.idle()]);
      assertEquals(sales.length, 2);
    } finally {
      await first.close({ drain: 0 });
    }
    allowed = true;
    const second = await createRuntime({ store, plugins: [plugin] });
    try {
      await second.idle();
      assertEquals(sales, ["previous-sale", sales[1], sales[1]]);
      assertEquals(await store.count("sale", {}), 2);
      assertEquals(await store.related("new", ["processor.failed"]), []);
    } finally {
      await second.close();
    }
  });
}

test("parallel nested calls reserve their places before asynchronous admission settles", async () => {
  const store = memoryStore();
  const runtime = await createRuntime({
    store,
    plugins: [{
      name: "parallel",
      actions: {
        first: defineAction({ allow: async () => true, run: () => 1 }),
        second: defineAction({ allow: people, run: () => 2 }),
        pair: defineAction({
          allow: people,
          run: (ctx) => Promise.all([ctx.call("first"), ctx.call("second")]),
        }),
      },
    }],
  });
  try {
    assertEquals(await runtime.call("pair", {}, { actor: ana, id: "pair" }), [1, 2]);
    const started = (await store.events(0)).filter((e) =>
      e.type === "action.started" && e.cause === "pair"
    );
    assertEquals(Object.fromEntries(started.map((e) => [e.data.action, e.id.split(".")[1]])), {
      first: "1",
      second: "2",
    });
  } finally {
    await runtime.close();
  }
});
