/**
 * An actor's scope (a developer key's): what it may use from outside, by
 * exact name. The runtime checks it only where a call from outside comes
 * in, beside `allow`: calls, queries, Views it renders, direct reads over
 * the socket; and a scoped actor emits nothing. Never inside a job: an
 * Action it may call writes, emits and calls what it does, as usual. An
 * actor without a scope is unchanged. A key's connections end apart from
 * its person's.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  inScope,
  type Runtime,
  type ViewContext,
} from "../mod.ts";
import { connect } from "../client.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
/** A key of Ana's: it adds notes, counts them, reads them directly, and sees their count. */
const key: Actor = {
  ...ana,
  key: "k1",
  scope: { call: ["note.add"], query: ["note.count"], view: ["note.count"], read: ["note"] },
};
const person = (actor: Actor) => actor.kind === "person";

/** Notes, each its owner's, and a log of what was done (read only through the rules too). */
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: { owner: { type: "string" }, text: { type: "string" } },
      },
      queries: {
        count: { allow: person, run: (notes) => notes.countDocuments({}) },
        texts: {
          allow: person,
          run: async (notes) => (await notes.find({}, { sort: { text: 1 } })).map((n) => n.text),
        },
      },
    }),
    log: defineCollection({
      schema: {
        type: "object",
        properties: { owner: { type: "string" }, what: { type: "string" } },
      },
    }),
  },
  events: {
    "note.seen": { schema: { type: "object" }, allow: person },
  },
  actions: {
    // Writes a note, then, as its work, another collection, an event and a call it isn't scoped for.
    "note.add": defineAction({
      allow: person,
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (ctx, input) => {
        await ctx.db.collection("note").insertOne({ owner: ctx.actor!.id, text: input.text });
        await ctx.emit("note.seen", {});
        await ctx.call("note.tally", { what: `added ${input.text}` });
        return { ok: true };
      },
    }),
    "note.tally": defineAction({
      allow: person,
      input: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
      run: async (ctx, input) => {
        await ctx.db.collection("log").insertOne({ owner: ctx.actor!.id, what: input.what });
      },
    }),
  },
  guard: (actor, { collection }) =>
    collection === "note" || collection === "log" ? { owner: actor.id } : undefined,
  views: {
    "note.count": (_: unknown, ctx: ViewContext) =>
      `${ctx.db.collection("note").countDocuments({}).value ?? 0} notes`,
    "note.texts": (_: unknown, ctx: ViewContext) => ctx.db.collection("note").query("texts").value,
  },
});

/** The client's front end: notes and the log, read directly; and the queries. */
const front = definePlugin({
  name: "notes-front",
  requires: ["notes"],
  views: {
    notes: (_: unknown, ctx: ViewContext) =>
      (ctx.db.collection<{ text: string }>("note").find({}).value ?? []).map((n) => n.text),
    log: (_: unknown, ctx: ViewContext) => ctx.db.collection("log").find({}).value,
    count: (_: unknown, ctx: ViewContext) => ctx.db.collection("note").query("count").value,
    texts: (_: unknown, ctx: ViewContext) => ctx.db.collection("note").query("texts").value,
  },
});

async function setup(
  fn: (rt: Runtime, as: (actor: Actor) => ReturnType<typeof connect>) => Promise<void>,
) {
  const topic = `scope-test.${crypto.randomUUID()}`;
  const tickets = new Map<string, Actor>();
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes],
    transports: [{ type: "in-process", config: { topic } }],
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
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await rt.close();
  }
}

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** What a View observed once comes to: its value, or why it failed. */
async function shown(observed: { ready: Promise<unknown>; close(): void }) {
  const out = await observed.ready as { status: string; value?: unknown; error?: Error };
  observed.close();
  return out.status === "ready" ? out.value : `failed: ${out.error?.message}`;
}

test("inScope: no scope is unscoped; a scope lets only what it lists, by kind, by exact name", () => {
  assertEquals(inScope(ana, "call", "anything"), true);
  assertEquals(inScope(undefined, "write", "note"), true);
  assertEquals(inScope(key, "call", "note.add"), true);
  assertEquals(inScope(key, "call", "note.tally"), false);
  // Kinds apart: a name that's a query isn't a call, nor a collection it reads one it writes.
  assertEquals(inScope(key, "call", "note.count"), false);
  assertEquals(inScope(key, "read", "note"), true);
  assertEquals(inScope(key, "write", "note"), false);
  // No wildcards; a scope it can't read lets nothing.
  assertEquals(inScope({ ...ana, scope: { call: ["*"] } }, "call", "note.add"), false);
  assertEquals(inScope({ ...ana, scope: null }, "read", "note"), false);
  assertEquals(inScope({ ...ana, scope: { read: "note" } }, "read", "note"), false);
});

test("a scoped call: only what its scope lists; what it calls writes, emits and calls as usual", async () => {
  await setup(async (rt) => {
    const seen: string[] = [];
    const stop = rt.subscribe((item) => {
      if (item.kind === "event") seen.push(item.event.type);
    });
    // Not in its scope: refused, before anything runs, though `allow` lets its person.
    const refused = await assertRejects(() =>
      rt.call("note.tally", { what: "x" }, { actor: key })
    ) as Error & { code: string };
    assertEquals(refused.code, "forbidden");
    assert(refused.message.includes("not in its scope"));
    assertEquals(await code(rt.call("note.tally", { what: "mine" }, { actor: ana })), "done");
    // In it: it writes a note, then the log (another collection), an event and a call the
    // key isn't scoped for, all as the key.
    assertEquals(await rt.call("note.add", { text: "hi" }, { actor: key }), { ok: true });
    await rt.idle();
    stop();
    assert(seen.includes("note.created") && seen.includes("log.created"));
    assert(seen.includes("note.seen"));
    assertEquals(await rt.query("note.texts", {}, { actor: ana }), ["hi"]);
    // The rules still hold for it: it reaches only its person's.
    await rt.call("note.add", { text: "bob's" }, { actor: { kind: "person", id: "bob" } });
    assertEquals(await rt.query("note.count", {}, { actor: key }), 1);
  });
});

test("a scoped actor emits nothing; its person emits as the event allows", async () => {
  await setup(async (rt) => {
    assertEquals(await code(rt.emit("note.seen", {}, { actor: key })), "forbidden");
    assertEquals(await code(rt.emit("note.seen", {}, { actor: ana })), "done");
  });
});

test("queries and Views rendered here: only those its scope lists", async () => {
  await setup(async (rt) => {
    await rt.call("note.add", { text: "a" }, { actor: ana });
    assertEquals(await rt.query("note.count", {}, { actor: key }), 1);
    assertEquals(await code(rt.query("note.texts", {}, { actor: key })), "forbidden");
    assertEquals(await rt.query("note.texts", {}, { actor: ana }), ["a"]);
    assertEquals(await shown(rt.observe("note.count", {}, { actor: key })), "1 notes");
    // Its reads aren't asked about: the View is what it asked for.
    const other = await shown(rt.observe("note.texts", {}, { actor: key }));
    assert(String(other).includes('may not see "note.texts": not in its scope'), String(other));
    assertEquals(await shown(rt.observe("note.texts", {}, { actor: ana })), ["a"]);
  });
});

test("over the socket: direct reads, queries, calls and events, as its scope lists", async () => {
  await setup(async (rt, as) => {
    await rt.call("note.add", { text: "a" }, { actor: ana });
    await rt.call("note.tally", { what: "b" }, { actor: ana });
    const client = as(key);
    await client.ready;
    // A collection it reads, directly, under the rules; one it doesn't list, refused.
    assertEquals(await shown(client.observe("notes", {})), ["a"]);
    const log = await shown(client.observe("log", {}));
    assert(String(log).includes('may not read "log": not in its scope'), String(log));
    // A query it lists; one it doesn't.
    assertEquals(await shown(client.observe("count", {})), 1);
    assert(String(await shown(client.observe("texts", {}))).includes("may not run"));
    // A call it lists; one it doesn't; an event, never.
    assertEquals(await client.call("note.add", { text: "c" }), { ok: true });
    assertEquals(await code(client.call("note.tally", { what: "d" })), "forbidden");
    assertEquals(await code(client.emit("note.seen", {})), "forbidden");
    // Its person, unscoped, reads and calls it all.
    const hers = as(ana);
    await hers.ready;
    // The key's call did its work as the key's person: the log has it too.
    const logged = await shown(hers.observe("log", {})) as { what: string }[];
    assertEquals(logged.map((l) => l.what).sort(), ["added a", "added c", "b"]);
    assertEquals(await shown(hers.observe("texts", {})), ["a", "c"]);
  });
});

test("a key's connections end apart from its person's", async () => {
  await setup(async (rt, as) => {
    const theirs = as(key);
    const hers = as(ana);
    await Promise.all([theirs.ready, hers.ready]);
    assertEquals(rt.stats().browsers, 2);
    // Ending the key ends only its connection.
    assertEquals(rt.disconnect(key), 1);
    assertEquals(rt.stats().browsers, 1);
    assertEquals(await hers.call("note.add", { text: "still" }), { ok: true });
    await theirs.close();
    // Her signing out ends hers, not a key's.
    const again = as(key);
    await again.ready;
    assertEquals(rt.disconnect(ana), 1);
    assertEquals(await again.call("note.add", { text: "key" }), { ok: true });
  });
});
