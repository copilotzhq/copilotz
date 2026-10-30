/**
 * Records: a ledger collection takes appends only. `ctx.record` costs no call
 * of its own (it rides the job's next write, or goes when the job ends), is
 * kept even when the job fails, can be made in a read, and a record sent
 * twice is kept once.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime, defineAction, defineCollection, definePlugin, type Store } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `r_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

type Used = { _id: string; meter: string; quantity: number };

const ledger = definePlugin({
  name: "ledger",
  collections: {
    used: defineCollection({
      records: true,
      schema: {
        type: "object",
        properties: { meter: { type: "string" }, quantity: { type: "number" } },
        required: ["meter", "quantity"],
      },
      queries: {
        all: (used) => used.find({}, { sort: { meter: 1 } }),
        // A read that uses something, and records it.
        priced: (used, _params, ctx) => {
          ctx.record("used", { meter: "lookup", quantity: 1 });
          return used.countDocuments({});
        },
      },
    }),
    note: defineCollection({ schema: { type: "object" } }),
  },
  actions: {
    "work.do": defineAction({
      input: { type: "object", properties: { fail: { type: "boolean" } } },
      run: async (ctx, input) => {
        ctx.record("used", { meter: "llm", quantity: 120 });
        ctx.record("used", { _id: "fixed", meter: "tool", quantity: 1 });
        if (input.fail) throw new Error("after the model call, something broke");
        await ctx.db.collection("note").insertOne({ done: true });
      },
    }),
    "work.quiet": defineAction({
      input: { type: "object" },
      record: false,
      run: (ctx) => {
        ctx.record("used", { meter: "llm", quantity: 7 });
      },
    }),
    "work.edit": defineAction({
      input: { type: "object" },
      record: false,
      run: (ctx) =>
        ctx.db.collection("used").updateOne({ _id: "fixed" }, { $set: { quantity: 2 } }),
    }),
    "work.bad": defineAction({
      input: { type: "object" },
      record: false,
      run: (ctx) => ctx.record("used", { meter: "llm" }),
    }),
  },
});

const start = async (make: () => Store | Promise<Store>) => {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [ledger] });
  return Object.assign(runtime, { log: () => store.events(0) });
};

each("a record rides the job's next write and costs no call of its own", async (make) => {
  const runtime = await start(make);
  const before = runtime.stats().calls;
  await runtime.call("work.do", {});
  // The insert (with the call's start and both records), then its completion.
  assertEquals(runtime.stats().calls - before, 2);
  const used = await runtime.query<Used[]>("used.all");
  assertEquals(used.map((u) => [u.meter, u.quantity]), [["llm", 120], ["tool", 1]]);
  // Records are their own record: no lifecycle events.
  const events = await runtime.log();
  assertEquals(events.filter((e) => e.type.startsWith("used.")), []);
  assertEquals(events.filter((e) => e.type === "note.created").length, 1);
  await runtime.close();
});

each("with nothing else to write, records go when the job ends", async (make) => {
  const runtime = await start(make);
  await runtime.call("work.quiet", {});
  assertEquals((await runtime.query<Used[]>("used.all")).map((u) => u.quantity), [7]);
  await runtime.close();
});

each("a failed job keeps what it recorded", async (make) => {
  const runtime = await start(make);
  await assertRejects(() => runtime.call("work.do", { fail: true }), Error, "something broke");
  const used = await runtime.query<Used[]>("used.all");
  assertEquals(used.map((u) => u.meter), ["llm", "tool"]);
  // Again: the record with a given id is kept once; the other is a new use.
  await runtime.call("work.do", {});
  const again = await runtime.query<Used[]>("used.all");
  assertEquals(again.map((u) => u.meter), ["llm", "llm", "tool"]);
  await runtime.close();
});

each("a read records what it used", async (make) => {
  const runtime = await start(make);
  assertEquals(await runtime.query("used.priced"), 0);
  assertEquals((await runtime.query<Used[]>("used.all")).map((u) => u.meter), ["lookup"]);
  await runtime.close();
});

each("records are appended, never changed; a bad one fails where it's made", async (make) => {
  const runtime = await start(make);
  await runtime.call("work.quiet", {});
  const edit = await assertRejects(() => runtime.call("work.edit", {}));
  assertStringIncludes((edit as Error).message, "appended, never changed");
  const bad = await assertRejects(() => runtime.call("work.bad", {}));
  assertStringIncludes((bad as Error).message, 'record in "used"');
  await runtime.close();
});
