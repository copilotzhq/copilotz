/**
 * A client: the runtime as one person, elsewhere (a browser). It connects
 * with a ticket its host issued, observes Views here with reads from the
 * owner under the rules, sees what changes as it changes, and calls and
 * emits as that person.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Observed,
  type Runtime,
  type ViewContext,
} from "../mod.ts";
import { connect } from "../client.ts";
import { lines } from "../wire.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { host, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
type Note = { _id: string; owner: string; text: string; secret?: string };

/** What the `slow` query waits for. */
let held: Promise<void> = Promise.resolve();

/** The server's plugin: notes each person reaches only their own of, with a private field. */
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: { owner: { type: "string" }, text: { type: "string" } },
      },
      private: ["secret"],
      queries: {
        count: {
          allow: (actor) => actor.kind === "person",
          run: (notes) => notes.countDocuments({}),
        },
      },
    }),
    // No rule speaks for it: code reads it freely, a browser only through its query.
    tally: defineCollection({
      schema: { type: "object" },
      queries: {
        total: {
          allow: (actor) => actor.kind === "person",
          run: (tally) => tally.countDocuments({}),
        },
        // Lets no one from outside.
        all: (tally) => tally.find({}),
        // Answers once `held` lets it: its batch's answer waits for it.
        slow: {
          allow: (actor) => actor.kind === "person",
          run: async () => {
            await held;
            return "slow";
          },
        },
      },
    }),
  },
  events: {
    "note.seen": { schema: { type: "object" }, allow: (actor) => actor.kind === "person" },
  },
  actions: {
    "note.add": defineAction({
      allow: (actor) => actor.kind === "person",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (ctx, input) => {
        await ctx.db.collection("note").insertOne({
          owner: ctx.actor!.id,
          text: input.text,
          secret: "s",
        });
        return { ok: true };
      },
    }),
    "note.wipe": defineAction({ input: { type: "object" }, run: () => null }),
  },
  guard: (actor, { collection }) => collection === "note" ? { owner: actor.id } : undefined,
});

/** The client's front end: a View of the notes, and how many. */
const front = definePlugin({
  name: "notes-test",
  requires: ["notes"],
  views: {
    notes: {
      test: (_: unknown, ctx: ViewContext) => {
        const all = ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } }).value ?? [];
        const count = ctx.db.collection("note").query<number>("count").value;
        return { texts: all.map((n) => n.text), secrets: all.map((n) => n.secret ?? null), count };
      },
    },
    tally: { test: (_: unknown, ctx: ViewContext) => ctx.db.collection("tally").find({}).value },
    total: {
      test: (_: unknown, ctx: ViewContext) => ctx.db.collection("tally").query("total").value,
    },
    all: {
      test: (_: unknown, ctx: ViewContext) => ctx.db.collection("tally").query("all").value,
    },
    // Two parts making the same read in one pass (a sidebar and a page reading the spaces).
    pair: {
      test: (_: unknown, ctx: ViewContext) => [
        ctx.show("counted", { _id: "left" }),
        ctx.show("counted", { _id: "right" }),
      ],
    },
    counted: {
      test: (_: unknown, ctx: ViewContext) =>
        ctx.db.collection("note").query<number>("count").value,
    },
    // Reads asked for in one batch, the second holding back the answer to both.
    racing: {
      test: (_: unknown, ctx: ViewContext) => [
        ctx.show("texts", { _id: "texts" }),
        ctx.show("slow", { _id: "slow" }),
      ],
    },
    texts: {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<Note>("note").find({}, { sort: { text: 1 } }).value ?? []).map((n) =>
          n.text
        ),
    },
    slow: {
      test: (_: unknown, ctx: ViewContext) => ctx.db.collection("tally").query("slow").value,
    },
  },
});

async function setup(
  fn: (rt: Runtime, as: (actor: Actor) => ReturnType<typeof connect>) => Promise<void>,
) {
  const topic = `client-test.${crypto.randomUUID()}`;
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes],
    transports: [{ type: "in-process", config: { topic } }],
    // A ticket works once.
    admit: (secret) => {
      const actor = tickets.get(secret);
      tickets.delete(secret);
      return actor;
    },
  });
  const clients: ReturnType<typeof connect>[] = [];
  const as = (actor: Actor) => {
    const client = connect({
      transport: { type: "in-process", config: { topic } },
      ticket: () => {
        const secret = crypto.randomUUID();
        tickets.set(secret, actor);
        return Promise.resolve(secret);
      },
      plugins: [front],
    });
    clients.push(client);
    return client;
  };
  try {
    await fn(rt, as);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await rt.close();
  }
}

/** Until `check` holds (what the owner pushes arrives on its own time). */
async function until(check: () => boolean, what: string, ms = 2_000) {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(check(), what);
}

test("a client sees what its person reaches, as it changes", async () => {
  await setup(async (rt, as) => {
    await rt.call("note.add", { text: "bob's" }, { actor: bob });
    const client = as(ana);
    await client.ready;
    const view = client.observe<{ texts: string[]; secrets: unknown[]; count: number }>(
      "test",
      "notes",
      {},
    );
    assertEquals(await view.ready, {
      status: "ready",
      value: { texts: [], secrets: [], count: 0 },
    });
    // Ana adds a note: it shows, without the private field, and the count follows.
    assertEquals(await client.call("note.add", { text: "a1" }), { ok: true });
    const value = () => (view.get() as { value?: { texts: string[]; count: number } }).value;
    await until(() => value()?.texts.length === 1, "her note shows");
    assertEquals(view.get(), {
      status: "ready",
      value: { texts: ["a1"], secrets: [null], count: 1 },
    });
    // Someone else's change elsewhere doesn't reach her.
    await rt.call("note.add", { text: "bob2" }, { actor: bob });
    await rt.idle();
    await client.idle();
    assertEquals(value()?.texts, ["a1"]);
    view.close();
  });
});

test("a client reads directly only what a rule speaks for; anything else, through queries that let it", async () => {
  await setup(async (_rt, as) => {
    const client = as(ana);
    await client.ready;
    const direct = client.observe("test", "tally", {});
    const failed = await direct.ready;
    assertEquals(failed.status, "failed");
    assert(
      String((failed as { error: Error }).error.message).includes("No rule lets a browser read"),
    );
    const total = client.observe("test", "total", {});
    assertEquals(await total.ready, { status: "ready", value: 0 });
    const all = client.observe("test", "all", {});
    const refused = await all.ready;
    assertEquals(refused.status, "failed");
    assert(String((refused as { error: Error }).error.message).includes('may not run "tally.all"'));
    direct.close();
    total.close();
    all.close();
  });
});

test("the same read made twice at once is asked for, and answered, once", async () => {
  await setup(async (_rt, as) => {
    const client = as(ana);
    await client.ready;
    const parts: Observed[] = [];
    const view = client.observe("test", "pair", {}, {
      part: (part) => (parts.push(part), part),
    });
    const ready = await Promise.race([
      view.ready.then((o) => o.status),
      new Promise((r) => setTimeout(() => r("still loading"), 2_000)),
    ]);
    assertEquals(ready, "ready");
    const counts = () => parts.slice(0, 2).map((p) => (p.get() as { value?: number }).value);
    assertEquals(counts(), [0, 0]);
    await client.call("note.add", { text: "a1" });
    await until(() => counts().every((n) => n === 1), "both follow");
    view.close();
  });
});

/** A client over a real socket, with the sockets it opens, to drop one. */
async function overSocket(
  fn: (rt: Runtime, client: ReturnType<typeof connect>, sockets: WebSocket[]) => Promise<void>,
) {
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes],
    transports: [{ type: "websocket", config: { path: "/browsers" } }],
    admit: (secret) => {
      const actor = tickets.get(secret);
      tickets.delete(secret);
      return actor;
    },
  });
  const listener = await host(rt.hypervisor);
  const sockets: WebSocket[] = [];
  const client = connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${new URL(String(listener.url)).port}/browsers`,
        allowInsecureLoopback: true,
        socket: ({ url, protocol }) => {
          const socket = new WebSocket(url, protocol);
          sockets.push(socket);
          return socket;
        },
      },
    },
    ticket: () => {
      const secret = crypto.randomUUID();
      tickets.set(secret, ana);
      return Promise.resolve(secret);
    },
    plugins: [front],
  });
  try {
    await client.ready;
    await fn(rt, client, sockets);
  } finally {
    await client.close().catch(() => {});
    await listener.shutdown();
    await rt.close();
  }
}

test("a client that loses its connection sees what changed meanwhile, and what changes after", async () => {
  await overSocket(async (rt, client, sockets) => {
    const view = client.observe<{ texts: string[] }>("test", "notes", {});
    await view.ready;
    const texts = () => (view.get() as { value?: { texts: string[] } }).value?.texts ?? [];
    // The connection drops; a note is added meanwhile.
    sockets.at(-1)!.close();
    await rt.call("note.add", { text: "a1" }, { actor: ana });
    await until(() => texts().length === 1, "what changed meanwhile shows", 10_000);
    // And the new connection is watched: what changes next shows too.
    await client.call("note.add", { text: "a2" });
    await until(() => texts().length === 2, "what changes after shows", 5_000);
    assertEquals(texts(), ["a1", "a2"]);
    assert(sockets.length >= 2, "it connected again");
    view.close();
  });
});

test("what's pushed while a read's batch is answered isn't lost to the older answer", async () => {
  await setup(async (rt, as) => {
    const release = Promise.withResolvers<void>();
    held = release.promise;
    try {
      const client = as(ana);
      await client.ready;
      const parts: Observed[] = [];
      const view = client.observe("test", "racing", {}, {
        part: (part) => (parts.push(part), part),
      });
      await new Promise((r) => setTimeout(r, 100));
      // The batch's answer waits for its slow read; the notes are already watched.
      await rt.call("note.add", { text: "a1" }, { actor: ana });
      await new Promise((r) => setTimeout(r, 100));
      release.resolve();
      await view.ready;
      const texts = () => (parts[0].get() as { value?: string[] }).value ?? [];
      await until(() => texts().length === 1, "the note shows");
      view.close();
    } finally {
      release.resolve();
      held = Promise.resolve();
    }
  });
});

test("what's pushed while a new connection asks again isn't lost to the older answer", async () => {
  await overSocket(async (rt, client, sockets) => {
    const parts: Observed[] = [];
    const view = client.observe("test", "racing", {}, {
      part: (part) => (parts.push(part), part),
    });
    await view.ready;
    const texts = () => (parts[0].get() as { value?: string[] }).value ?? [];
    const release = Promise.withResolvers<void>();
    held = release.promise;
    try {
      // The connection drops, and comes back asking again; the answer waits for the slow read.
      sockets.at(-1)!.close();
      await until(() => sockets.length >= 2, "it connects again", 10_000);
      await new Promise((r) => setTimeout(r, 300));
      await rt.call("note.add", { text: "a1" }, { actor: ana });
      await until(() => texts().length === 1, "the note is pushed");
      release.resolve();
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(texts(), ["a1"]);
      view.close();
    } finally {
      release.resolve();
      held = Promise.resolve();
    }
  });
});

test("what the owner pushes is read where streams can't be iterated (Safari)", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // A line split across chunks, and two in one.
      controller.enqueue(encoder.encode('{"key":"a","va'));
      controller.enqueue(encoder.encode('lue":1}\n{"key":"b","value":2}\n'));
      controller.close();
    },
  });
  // As in Safari: no async iteration on streams.
  Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
  const read: unknown[] = [];
  for await (const line of lines(body)) read.push(line);
  assertEquals(read, [{ key: "a", value: 1 }, { key: "b", value: 2 }]);
});

test("a client calls and emits only what its person may", async () => {
  await setup(async (_rt, as) => {
    const client = as(ana);
    await client.ready;
    await client.emit("note.seen", {});
    await assertRejects(() => client.emit("note.lost", {}), Error, "Undeclared event");
    await assertRejects(() => client.call("note.wipe", {}), Error, "may not call");
  });
});

test("a client without a valid ticket isn't let in", async () => {
  const topic = `client-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes],
    transports: [{ type: "in-process", config: { topic } }],
    admit: () => undefined,
  });
  const client = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => Promise.resolve("forged"),
    plugins: [front],
  });
  try {
    await assertRejects(() => client.ready);
  } finally {
    await client.close().catch(() => {});
    await rt.close();
  }
});
