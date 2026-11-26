/**
 * A Processor's two options.
 *
 * - `as`: it runs as a named grant, for nobody (no `via`), where the event
 *   was. Its writes and calls record the grant and the event they answer, it
 *   reads as whoever acted only when it says so (`ctx.as(event.actor)`), and
 *   code going beyond from it is asked about the grant, never about the
 *   event's actor. A name that isn't one fails at startup.
 * - `start: "now"`: new, it begins at the log's end, saved before anything is
 *   delivered, so a crash before its first delivery skips nothing. A saved
 *   position is never moved, each store (a pool's tenant) has its own end, and
 *   without it a new Processor reads the log from its first event, as before.
 *   On memory, SQLite, PGlite and PostgreSQL.
 *
 * Refused, code going beyond is said to go beyond what the actor it acts for
 * may do, or what the labels' plugin says it goes beyond.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  grant,
  people,
  personOf,
  type ProcessorDef,
  type Runtime,
  runtimes,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";

const text = { type: "string" } as const;
const ana: Actor = { kind: "person", id: "ana", in: "shop" };
const bob: Actor = { kind: "person", id: "bob", in: "shop" };
const carol: Actor = { kind: "person", id: "carol", in: "shop" };

/** Whom the labels were asked about: the actor code went beyond. */
const asked: Actor[] = [];

/**
 * Notes, each its owner's alone. `note.count` counts every one through a
 * grant its code takes, `note.tally` as a grant it declares: going beyond
 * their caller, which the labels refuse for Ana with no words of their own,
 * for Bob as going beyond what Bob may see, and let anyone else's code do. A
 * Processor copies each note's news, as `as` says or as the note's writer.
 */
const notes = (as?: string) =>
  definePlugin({
    name: "notes",
    collections: {
      note: defineCollection({
        schema: { type: "object", properties: { owner: text, text }, required: ["owner", "text"] },
      }),
      copy: defineCollection({ schema: { type: "object", properties: { of: text } } }),
    },
    guard: (actor, { collection }) =>
      collection === "note" ? { owner: personOf(actor) ?? "" } : undefined,
    labels: {
      read: () => [],
      write: (_actor, _collection, doc) => doc,
      elevate: (actor) => {
        asked.push(actor);
        return actor.id === "ana" ? false : actor.id === "bob" ? "what Bob may see" : true;
      },
    },
    actions: {
      "note.add": defineAction({
        allow: people,
        input: { type: "object", properties: { text }, required: ["text"] },
        run: (ctx, input) =>
          ctx.db.collection("note").insertOne({ owner: personOf(ctx.actor)!, text: input.text }),
      }),
      "note.count": defineAction({
        allow: people,
        run: (ctx) => ctx.as(grant("count")).db.collection("note").countDocuments({}),
      }),
      "note.tally": defineAction({
        allow: people,
        as: "tally",
        run: (ctx) => ctx.db.collection("note").countDocuments({}),
      }),
    },
    processors: {
      "note.copied": {
        on: "note.created",
        ...(as ? { as } : {}),
        run: async (ctx, event) => {
          const all = await ctx.db.collection("note").countDocuments({});
          const theirs = await ctx.as(event.actor).db.collection("note").countDocuments({});
          const said = (e: unknown) => (e as Error).message;
          const counted = await ctx.call("note.count", {}).catch(said);
          const tallied = await ctx.call("note.tally", {}).catch(said);
          await ctx.db.collection("copy").insertOne({
            of: event.data._id,
            actor: ctx.actor,
            in: ctx.in,
            all,
            theirs,
            counted,
            tallied,
          });
        },
      },
    },
  });

/** The copies the Processor made, in the order of their notes. */
async function copies(runtime: Runtime, store: Store) {
  await runtime.idle();
  const log = await store.events(0);
  const order = log.filter((e) => e.type === "note.created").map((e) => e.data._id);
  const made = await store.find("copy", {});
  return order.map((id) => {
    const { _id: _, of: __, ...copy } = made.find((c) => c.of === id)!;
    return copy;
  });
}

test("a Processor with `as` runs as its grant, for nobody; its writes and calls say so and why", async () => {
  asked.length = 0;
  const store = memoryStore();
  const runtime = await createRuntime({ store, plugins: [notes("copier")] });
  try {
    for (const [actor, said] of [[ana, "one"], [bob, "two"], [ana, "three"]] as const) {
      await runtime.call("note.add", { text: said }, { actor });
      await runtime.idle();
    }
    const copier = { kind: "system", id: "copier", in: "shop" };
    // It reads every note as itself; as whoever wrote one, only theirs. Going beyond from it
    // is asked about the grant alone, whoever wrote the note.
    assertEquals(await copies(runtime, store), [
      { actor: copier, in: "shop", all: 1, theirs: 1, counted: 1, tallied: 1 },
      { actor: copier, in: "shop", all: 2, theirs: 1, counted: 2, tallied: 2 },
      { actor: copier, in: "shop", all: 3, theirs: 2, counted: 3, tallied: 3 },
    ]);
    assertEquals([...new Set(asked.map((a) => JSON.stringify(a)))], [JSON.stringify(copier)]);
    // On the record: its writes and calls are the grant's, caused by the note they answer.
    const log = await store.events(0);
    const byId = new Map(log.map((e) => [e.id, e]));
    for (const copied of log.filter((e) => e.type === "copy.created")) {
      assertEquals(copied.actor, copier);
      assertEquals(byId.get(copied.cause!)?.type, "note.created");
    }
    const calls = log.filter((e) =>
      e.type === "action.started" && ["note.count", "note.tally"].includes(String(e.data.action))
    );
    assertEquals(calls.length, 6);
    for (const call of calls) {
      assertEquals(call.actor, copier);
      assertEquals(byId.get(call.cause!)?.type, "note.created");
    }
  } finally {
    await runtime.close();
  }
});

test("without `as`, a Processor runs as the event's actor; going beyond is refused in the labels' words, or the runtime's", async () => {
  asked.length = 0;
  const store = memoryStore();
  const runtime = await createRuntime({ store, plugins: [notes()] });
  try {
    for (const [actor, said] of [[ana, "one"], [bob, "two"], [carol, "three"]] as const) {
      await runtime.call("note.add", { text: said }, { actor });
      await runtime.idle();
    }
    assertEquals(await copies(runtime, store), [
      {
        actor: ana,
        in: "shop",
        all: 1,
        theirs: 1,
        counted: '"note.count" goes beyond what the actor it acts for may do',
        tallied: '"note.tally" goes beyond what the actor it acts for may do',
      },
      {
        actor: bob,
        in: "shop",
        all: 1,
        theirs: 1,
        counted: '"note.count" goes beyond what Bob may see',
        tallied: '"note.tally" goes beyond what Bob may see',
      },
      { actor: carol, in: "shop", all: 1, theirs: 1, counted: 3, tallied: 3 },
    ]);
    assertEquals([...new Set(asked.map((a) => a.id))], ["ana", "bob", "carol"]);
    // Called from outside, the same.
    await assertRejects(
      () => runtime.call("note.count", {}, { actor: ana }),
      Error,
      '"note.count" goes beyond what the actor it acts for may do',
    );
  } finally {
    await runtime.close();
  }
});

test("a Processor's `as` that names no grant, or a `start` other than now, fails at startup", async () => {
  const declaring = (def: Partial<ProcessorDef>) =>
    createRuntime({
      store: memoryStore(),
      plugins: [definePlugin({
        name: "odd",
        processors: { "odd.heard": { on: "x", run: () => {}, ...def } as ProcessorDef },
      })],
    });
  for (const as of ["", "  ", 7]) {
    await assertRejects(
      () => declaring({ as: as as string }),
      Error,
      'Processor "odd.heard" needs a named grant in as',
    );
  }
  await assertRejects(
    () => declaring({ start: "later" as "now" }),
    Error,
    'Processor "odd.heard" start can only be "now"',
  );
});

// --- start: "now" ---

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");

/** One database, opened as processes would, a store of its own each time; a tenant's, if named. */
type Shared = { open(tenant?: string): Promise<Store>; close(): Promise<void> };

/** On PostgreSQL, a schema of the test's own, on a pool its stores share (PGlite has one). */
async function postgres(url: string): Promise<Shared> {
  const pool = await postgresPool({ url, writes: 2, reads: 1 });
  const schema = `s_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    open: (tenant) => postgresStore({ pool, schema, ...(tenant ? { tenant } : {}) }),
    close: async () => {
      await pool.writes.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.close();
    },
  };
}

/** Each tenant's own, made once: what was there is there again. */
const kept = <T>(make: () => T) => {
  const made = new Map<string, T>();
  return (tenant = "") => {
    if (!made.has(tenant)) made.set(tenant, make());
    return made.get(tenant)!;
  };
};

const databases: Record<string, () => Promise<Shared>> = {
  // Memory is one process's: runtimes on one store stand for owners one after another.
  memory: () => {
    const store = kept(() => memoryStore());
    return Promise.resolve({
      open: (tenant) => Promise.resolve(store(tenant)),
      close: () => Promise.resolve(),
    });
  },
  sqlite: () => {
    const path = kept(() => tempFile(".sqlite"));
    return Promise.resolve({
      open: (tenant) => sqliteStore({ path: path(tenant) }),
      close: () => Promise.resolve(),
    });
  },
  pglite: () => postgres(":memory:"),
  ...(POSTGRES ? { postgres: () => postgres(POSTGRES) } : {}),
};

const each = (name: string, fn: (db: Shared) => Promise<void>) => {
  for (const [store, make] of Object.entries(databases)) {
    test(`${store}: ${name}`, async () => {
      const db = await make();
      try {
        await fn(db);
      } finally {
        await db.close();
      }
    });
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Messages, and what `inbox.heard` heard of them (and of pings, events that
 * commit alone): with the options given, or no Processor at all. `gate`, when
 * given, holds each delivery until it's let go.
 */
function inbox(options?: Pick<ProcessorDef, "start">, gate?: Promise<void>) {
  const heard: string[] = [];
  const plugin = definePlugin({
    name: "inbox",
    collections: {
      message: defineCollection({ schema: { type: "object", properties: { text } } }),
    },
    events: { "inbox.ping": { schema: { type: "object", properties: { text } } } },
    actions: {
      "message.add": defineAction({
        input: { type: "object", properties: { text }, required: ["text"] },
        run: (ctx, input) => ctx.db.collection("message").insertOne({ text: input.text }),
      }),
    },
    processors: options
      ? {
        "inbox.heard": {
          on: ["message.created", "inbox.ping"],
          ...options,
          run: async (_ctx, event: Event) => {
            const said = event.type === "inbox.ping" ? event.data : event.data.doc;
            heard.push(String((said as { text: string }).text));
            await gate;
          },
        },
      }
      : {},
  });
  return { plugin, heard };
}

const open = async (db: Shared, plugin: ReturnType<typeof inbox>["plugin"], tenant?: string) =>
  await createRuntime({
    store: await db.open(tenant),
    plugins: [plugin],
    warn: false,
    fenceCheck: false,
  });

/** Messages written before the Processor exists, by a runtime without it. */
async function before(db: Shared, texts: string[], tenant?: string) {
  const runtime = await open(db, inbox().plugin, tenant);
  for (const said of texts) await runtime.call("message.add", { text: said });
  await runtime.close();
}

/** Runs `work` with `console.error` kept quiet: a fenced owner says once that it lost its store. */
async function quietly(work: () => Promise<unknown>) {
  const error = console.error;
  console.error = () => {};
  try {
    await work();
  } finally {
    console.error = error;
  }
}

each(
  "a new Processor that starts now hears what comes after its first start, and nothing before",
  async (db) => {
    await before(db, ["old", "older"]);
    const { plugin, heard } = inbox({ start: "now" });
    const store = await db.open();
    const runtime = await createRuntime({
      store,
      plugins: [plugin],
      warn: false,
      fenceCheck: false,
    });
    try {
      // Where it starts is saved as it starts, before anything is delivered.
      const end = (await store.events(0)).at(-1)!.seq;
      assertEquals((await store.positions())["inbox.heard"], end);
      await runtime.call("message.add", { text: "new" });
      await runtime.idle();
      assertEquals(heard, ["new"]);
    } finally {
      await runtime.close();
    }
  },
);

each("a crash before its first delivery skips nothing when it starts again", async (db) => {
  await before(db, ["old"]);
  let release!: () => void;
  const first = inbox({ start: "now" }, new Promise((resolve) => release = resolve));
  const crashing = await open(db, first.plugin);
  let restarted: Runtime | undefined;
  try {
    // An event that commits alone (no position rides on it), its delivery still running
    // when the process goes: nothing was delivered, nothing moved.
    await crashing.emit("inbox.ping", { text: "during" });
    while (!first.heard.length) await sleep(5);
    // Another process takes the store, as a restart does.
    const again = inbox({ start: "now" });
    restarted = await open(db, again.plugin);
    await restarted.call("message.add", { text: "after" });
    await restarted.idle();
    assertEquals(again.heard, ["during", "after"]);
  } finally {
    release();
    await quietly(() => crashing.close().catch(() => {}));
    await restarted?.close();
  }
});

each("a saved position is kept: one that starts now still hears what it missed", async (db) => {
  const first = inbox({});
  const runtime = await open(db, first.plugin);
  await runtime.call("message.add", { text: "one" });
  await runtime.idle();
  assertEquals(first.heard, ["one"]);
  await runtime.close();
  // Down a while, then back as one that would start now: it goes on from where it was.
  await before(db, ["two"]);
  const again = inbox({ start: "now" });
  const back = await open(db, again.plugin);
  try {
    await back.call("message.add", { text: "three" });
    await back.idle();
    assertEquals(again.heard, ["two", "three"]);
  } finally {
    await back.close();
  }
});

each("without start, a new Processor hears the log from its first event, as before", async (db) => {
  await before(db, ["old", "older"]);
  const { plugin, heard } = inbox({});
  const runtime = await open(db, plugin);
  try {
    await runtime.call("message.add", { text: "new" });
    await runtime.idle();
    assertEquals(heard, ["old", "older", "new"]);
  } finally {
    await runtime.close();
  }
});

each("in a pool of runtimes, each store starts at its own end", async (db) => {
  await before(db, ["a1", "a2", "a3"], "a");
  await before(db, ["b1"], "b");
  const { plugin, heard } = inbox({ start: "now" });
  const pool = runtimes((tenant) => open(db, plugin, tenant));
  try {
    const a = (await pool.get("a"))!;
    await a.call("message.add", { text: "a new" });
    await a.idle();
    // The other opens after this one's log grew: its own end is where it starts.
    const b = (await pool.get("b"))!;
    await b.call("message.add", { text: "b new" });
    await b.idle();
    assertEquals(heard, ["a new", "b new"]);
  } finally {
    await pool.close();
  }
});
