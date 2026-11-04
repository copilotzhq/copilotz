/**
 * Private fields: what an actor's queries and Views read comes without
 * them; code acting for them (an Action) still reads them, and the system
 * reads everything. No event ever holds them, on any store.
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Store,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
type Account = { _id: string; name: string; token: string; owner: { id: string; secret: string } };

const plugin = definePlugin({
  name: "accounts",
  collections: {
    account: defineCollection({
      schema: { type: "object", properties: { name: { type: "string" } } },
      private: ["token", "owner.secret"],
      queries: {
        all: { allow: (actor) => actor.kind === "person", run: (accounts) => accounts.find({}) },
      },
    }),
  },
  actions: {
    "account.add": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("account").insertOne({
          _id: "a1",
          name: "mail",
          token: "tok_123",
          owner: { id: "ana", secret: "s3cr3t" },
        }),
    }),
    "account.rotate": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("account").updateOne({ _id: "a1" }, {
          $set: { token: "tok_456", "owner.secret": "n3w" },
        }),
    }),
    "account.drop": defineAction({
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("account").deleteOne({ _id: "a1" }),
    }),
    // A private path through an array reaches nothing there.
    "account.listed": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("account").insertOne({ _id: "a2", token: "tok_789", owner: ["ana"] }),
    }),
    // Code acting for Ana uses the token: it reads it, and says only what it did.
    "account.use": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: async (ctx) => {
        const [account] = await ctx.db.collection<Account>("account").find({});
        return { used: account.token.length, secret: account.owner.secret.length };
      },
    }),
  },
  views: {
    accounts: {
      test: (_: unknown, ctx: ViewContext) => ctx.db.collection("account").find({}).value ?? [],
    },
  },
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
};

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: private fields reach code acting for an actor, never what they read`, async () => {
    const rt = await createRuntime({ store: await make(), plugins: [plugin] });
    try {
      await rt.call("account.add", {});
      const seen = { _id: "a1", name: "mail", owner: { id: "ana" } };
      assertEquals(await rt.query("account.all", {}, { actor: ana }), [seen]);
      const accounts = rt.observe("test", "accounts", {}, { actor: ana });
      assertEquals(await accounts.ready, { status: "ready", value: [seen] });
      accounts.close();
      assertEquals(await rt.call("account.use", {}, { actor: ana }), { used: 7, secret: 6 });
      // The system reads everything.
      assertEquals((await rt.query<Account[]>("account.all", {}))[0].token, "tok_123");
    } finally {
      await rt.close();
    }
  });
}

const sql: Record<string, () => Store | Promise<Store>> = {
  ...stores,
  pglite: () => postgresStore({ url: ":memory:" }),
};

for (const [name, make] of Object.entries(sql)) {
  test(`${name}: the event log never holds a private field: not when made, changed or deleted`, async () => {
    const store = await make();
    const rt = await createRuntime({ store, plugins: [plugin] });
    try {
      for (const action of ["account.add", "account.rotate", "account.drop", "account.listed"]) {
        await rt.call(action, {});
      }
      const events = (await store.events(0, 100)).filter((e) => e.type.startsWith("account."));
      assertEquals(events.map((e) => e.type), [
        "account.created",
        "account.updated",
        "account.deleted",
        "account.created",
      ]);
      const logged = JSON.stringify(events);
      assertEquals(["tok_", "s3cr3t", "n3w"].filter((secret) => logged.includes(secret)), []);
      const docs = events.map((e) => (e.data as { doc: unknown }).doc);
      assertEquals(docs, [
        { _id: "a1", name: "mail", owner: { id: "ana" } },
        { _id: "a1", name: "mail", owner: { id: "ana" } },
        { _id: "a1", name: "mail", owner: { id: "ana" } },
        { _id: "a2", owner: ["ana"] },
      ]);
    } finally {
      await rt.close();
    }
  });
}
