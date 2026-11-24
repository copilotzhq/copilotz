/**
 * An unrecorded Action that acts as someone else (`ctx.as`) does so when a
 * read calls it too, read-only, as when an Action calls it. It used to be left
 * as the reader, quietly reading less than it asked for.
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  grant,
  type Runtime,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: () => memoryStore(),
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `r_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

const ana: Actor = { kind: "person", id: "ana" };

const probe = definePlugin({
  name: "probe",
  collections: {
    secret: defineCollection({
      schema: { type: "object", properties: { n: { type: "number" } } },
      queries: {
        counted: { allow: () => true, run: (_all, _params, ctx) => ctx.call("secret.count", {}) },
      },
    }),
  },
  // A person reaches none of them; the system, all.
  guard: (actor, { collection }) =>
    collection === "secret" && actor.kind === "person" ? { n: -1 } : undefined,
  actions: {
    "secret.seed": defineAction({
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("secret").insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]),
    }),
    // Counts every secret, acting as the system for one named reason.
    "secret.count": defineAction({
      input: { type: "object" },
      record: false,
      allow: () => true,
      run: (ctx) => ctx.as(grant("count")).db.collection("secret").countDocuments({}),
    }),
  },
});

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: an Action a read calls acts as someone else as when it's called`, async () => {
    const rt: Runtime = await createRuntime({ store: await make(), plugins: [probe] });
    try {
      await rt.call("secret.seed", {});
      // Called, by Ana: it counts all three, as the system.
      assertEquals(await rt.call("secret.count", {}, { actor: ana }), 3);
      // From her query, the same.
      assertEquals(await rt.query("secret.counted", {}, { actor: ana }), 3);
    } finally {
      await rt.close();
    }
  });
}
