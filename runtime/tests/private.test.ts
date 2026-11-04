/**
 * Private fields: what an actor's queries and Views read comes without
 * them; code acting for them (an Action) still reads them, and the system
 * reads everything. An Action's private fields are never in the log, as
 * what it's given or what it returns, while retries still find its calls.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
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

/** How often the booking plugin's code ran, and what its tool calls got back each delivery. */
const ran = { setBuyer: 0, delivery: 0, got: [] as unknown[] };
const buyer = {
  type: "object",
  properties: { name: { type: "string" }, cpf: { type: "string" } },
} as const;

/** Personal data in, and back out: a buyer for a booking, as a tool would set it. */
const booking = definePlugin({
  name: "booking",
  collections: {
    booking: defineCollection({ schema: { type: "object" }, private: ["buyer"] }),
  },
  actions: {
    "booking.setBuyer": defineAction({
      input: {
        type: "object",
        properties: { booking: { type: "string" }, buyer },
        required: ["booking", "buyer"],
      },
      private: ["buyer"],
      run: async (ctx, input) => {
        ran.setBuyer++;
        await ctx.db.collection("booking").updateOne(
          { _id: input.booking },
          { $set: { buyer: input.buyer } },
          { upsert: true },
        );
        return { booking: input.booking, buyer: input.buyer, total: 10 };
      },
    }),
    // A card's number in, nothing private out: nothing is kept apart.
    "booking.pay": defineAction({
      input: {
        type: "object",
        properties: { booking: { type: "string" }, card: { type: "object" } },
      },
      private: ["card.number"],
      run: () => ({ paid: true }),
    }),
    // Never ends on its own: it's stopped, and the owner records it.
    "booking.hold": defineAction({
      input: { type: "object", properties: { card: { type: "string" } } },
      private: ["card"],
      run: () => new Promise(() => {}),
    }),
    "booking.ask": defineAction({
      input: { type: "object", properties: { changes: { type: "boolean" } } },
      run: (ctx, input) => ctx.emit("booking.asked", input),
    }),
  },
  events: { "booking.asked": { schema: { type: "object" } } },
  processors: {
    // As a step's tool calls run: together, each in a branch of its own. It
    // fails once after they ran, so it's delivered again.
    "booking.step": {
      on: "booking.asked",
      run: async (ctx, event) => {
        // `changes`: the retry's model gave another CPF for Ana.
        const cpf = event.data.changes ? `cpf-${ran.delivery}` : "123.456.789-00";
        ran.got.push(
          await Promise.all([
            ctx.branch("1.0").call("booking.setBuyer", {
              booking: "b1",
              buyer: { name: "Ana Souza", cpf },
            }),
            ctx.branch("1.1").call("booking.setBuyer", {
              booking: "b2",
              buyer: { name: "Bia Lima", cpf: "987.654.321-00" },
            }),
          ]),
        );
        if (++ran.delivery === 1) throw new Error("the step fails after its tools ran");
      },
    },
  },
});

const PRIVATE = [
  "Ana Souza",
  "Bia Lima",
  "123.456.789-00",
  "987.654.321-00",
  "4111 1111 1111 1111",
];
/** Whether any private value is anywhere in these events. */
const leaks = (events: Event[]) =>
  PRIVATE.filter((value) => JSON.stringify(events).includes(value));

for (const [name, make] of Object.entries(sql)) {
  test(`${name}: an Action's private fields stay out of the log, and a retry gets all it returned`, async () => {
    Object.assign(ran, { setBuyer: 0, delivery: 0, got: [] });
    const store = await make();
    const rt = await createRuntime({ store, plugins: [booking] });
    try {
      const input = { booking: "b1", buyer: { name: "Ana Souza", cpf: "123.456.789-00" } };
      const first = await rt.call("booking.setBuyer", input, { id: "c1" });
      assertEquals(first, { ...input, total: 10 });
      // The same call again answers from its record, whole, without running.
      assertEquals(await rt.call("booking.setBuyer", input, { id: "c1" }), first);
      assertEquals(ran.setBuyer, 1);
      // Another CPF is another call: its id is taken.
      await assertRejects(
        () =>
          rt.call("booking.setBuyer", { ...input, buyer: { ...input.buyer, cpf: "1" } }, {
            id: "c1",
          }),
        Error,
        "already used for a different call",
      );
      // Nothing private in a result: nothing kept apart.
      await rt.call("booking.pay", {
        booking: "b1",
        card: { number: "4111 1111 1111 1111", brand: "visa" },
      }, {
        id: "c2",
      });

      const events = await store.events(0);
      assertEquals(leaks(events), []);
      const of = (id: string, type: string) =>
        events.find((e) => (e.id === id || e.cause === id) && e.type === type)!.data;
      assertEquals(of("c1", "action.started").input, { booking: "b1" });
      assertEquals(of("c1", "action.completed").result, { booking: "b1", total: 10 });
      assertEquals(of("c1", "action.completed").private, true);
      assertEquals(of("c2", "action.started").input, { booking: "b1", card: { brand: "visa" } });
      assertEquals(of("c2", "action.completed").result, { paid: true });
      assertEquals(of("c2", "action.completed").private, undefined);
      // What a retry answers with is kept apart, with no event of its own.
      assertEquals(await store.find("sys.results", {}), [{ _id: "c1", result: first }]);
    } finally {
      await rt.close();
    }
  });

  test(`${name}: a retried delivery finds the calls its tools made with private input`, async () => {
    Object.assign(ran, { setBuyer: 0, delivery: 0, got: [] });
    const store = await make();
    const rt = await createRuntime({ store, plugins: [booking] });
    try {
      await rt.call("booking.ask", {});
      await rt.idle();
      assertEquals([ran.delivery, ran.setBuyer], [2, 2]);
      // The retry got back what each call returned the first time, all of it.
      assertEquals(ran.got[1], ran.got[0]);
      assertEquals((ran.got[0] as { buyer: unknown }[])[0].buyer, {
        name: "Ana Souza",
        cpf: "123.456.789-00",
      });
      const events = await store.events(0);
      assertEquals(leaks(events), []);
      // Its two calls ran together: they start in the log in either order.
      const started = events.filter((e) => e.type === "action.started" && e.cause)
        .map((e) => e.data.input as { booking: string })
        .sort((a, b) => a.booking.localeCompare(b.booking));
      assertEquals(started, [{ booking: "b1" }, { booking: "b2" }]);
    } finally {
      await rt.close();
    }
  });
}

test("a retried delivery whose tool now gives other private input makes a new call", async () => {
  Object.assign(ran, { setBuyer: 0, delivery: 0, got: [] });
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [booking] });
  try {
    await rt.call("booking.ask", { changes: true });
    await rt.idle();
    // Ana's call ran again, with her new CPF; Bia's answered from the log.
    assertEquals([ran.delivery, ran.setBuyer], [2, 3]);
    const events = await store.events(0);
    const ana = events.filter((e) =>
      e.type === "action.started" && (e.data.input as { booking?: string }).booking === "b1"
    );
    // The same in the log, but two calls: the ids hash the whole input.
    assertEquals(ana.map((e) => e.data.input), [{ booking: "b1" }, { booking: "b1" }]);
    assert(ana[0].id !== ana[1].id && ana[0].data.inputHash !== ana[1].data.inputHash);
    assertEquals(leaks(events), []);
    assertEquals(JSON.stringify(events).includes("cpf-"), false);
  } finally {
    await rt.close();
  }
});

test("a call stopped before it recorded anything is recorded by the owner, without its private fields", async () => {
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [booking] });
  try {
    const call = rt.call("booking.hold", { card: "4111 1111 1111 1111" }, { id: "held" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(await rt.cancel({ call: "held" }));
    await assertRejects(() => call);
    const events = await store.events(0);
    const started = events.find((e) => e.id === "held")!;
    assertEquals(started.data.input, {});
    assertEquals(events.find((e) => e.cause === "held")!.type, "action.failed");
    assertEquals(leaks(events), []);
  } finally {
    await rt.close();
  }
});
