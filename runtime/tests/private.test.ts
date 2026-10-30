/**
 * Private fields: what an actor's queries and Views read comes without
 * them; code acting for them (an Action) still reads them, and the system
 * reads everything.
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
