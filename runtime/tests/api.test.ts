/**
 * The REST API (`/api/`, runtime/api.ts): every collection a rule speaks
 * for, read and written by whoever the request is, as their own operation:
 * only where a rule speaks for it (for writes, a rule asked about writes),
 * never `sys.*`, never a private field (returned, filtered by, written); the
 * guard keeps every write within reach, and what an update leaves within
 * it; the schema checks it; each write records its events. Actions by call
 * id (`Idempotency-Key`), queries, Views, emits, the reference, watches as
 * server-sent streams, and the events stream. An actor's scope is checked
 * there, and on the socket's writes too.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type Actor,
  connect,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  manualClock,
  type Runtime,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho, ticketFor } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
/** A key of Ana's that reads and writes notes, adds them, counts them. */
const writer: Actor = {
  ...ana,
  key: "k1",
  scope: { read: ["note"], write: ["note"], call: ["note.add"], query: ["note.mine"] },
};
/** One that only reads them. */
const reader: Actor = { ...ana, key: "k2", scope: { read: ["note"], view: ["note.count"] } };

const person = (actor: Actor) => actor.kind === "person";
const NOTHING = { _id: { $in: [] } };

type Note = { owner: string; text: string; status?: string; secret?: string };

/**
 * Notes: each person reads their own, and writes those not locked (what an
 * update leaves must still not be locked). A log no rule speaks for.
 */
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          text: { type: "string" },
          status: { type: "string" },
          secret: { type: "string" },
        },
        required: ["owner", "text"],
      },
      private: ["secret"],
      queries: {
        mine: { allow: person, run: (notes) => notes.find({}, { sort: { text: 1 } }) },
        all: (notes) => notes.find({}),
      },
    }),
    log: defineCollection({
      schema: { type: "object", properties: { what: { type: "string" } } },
    }),
  },
  guard: (actor, { collection, access }) => {
    if (collection !== "note") return undefined;
    if (actor.kind !== "person") return NOTHING;
    return access === "read" ? { owner: actor.id } : { owner: actor.id, status: { $ne: "locked" } };
  },
  events: { "note.seen": { schema: { type: "object" }, allow: person } },
  actions: {
    "note.add": defineAction({
      allow: person,
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (ctx, input) => {
        const { insertedId } = await ctx.db.collection("note").insertOne({
          owner: ctx.actor!.id,
          text: input.text,
        });
        return { note: insertedId };
      },
    }),
    // The system's: no `allow`. It writes what it's given, secrets and all.
    "note.put": defineAction({
      input: { type: "object" },
      run: async (ctx, input) => {
        await ctx.db.collection("note").insertOne(input as Note & { _id?: string });
        return null;
      },
    }),
    "note.get": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      record: false,
      run: (ctx, input) => ctx.db.collection("note").findOne({ _id: input.id }),
    }),
  },
  views: {
    "note.count": (_: unknown, ctx: ViewContext) =>
      `${ctx.db.collection("note").countDocuments({}).value ?? 0} notes`,
  },
});

type Setup = {
  rt: Runtime;
  /** A request as `actor` (none: anonymous), to `path`. */
  as(actor: Actor | null, path: string, init?: RequestInit): Promise<Response>;
};

async function setup(fn: (s: Setup) => Promise<void>, options: { clock?: boolean } = {}) {
  const topic = `api-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes, testWho],
    transports: [{ type: "in-process", config: { topic } }],
    ...(options.clock ? { clock: manualClock() } : {}),
  });
  try {
    await fn({
      rt,
      as: (actor, path, init = {}) => {
        const headers = new Headers(init.headers);
        if (actor) headers.set(TEST_ACTOR, JSON.stringify(actor));
        if (init.body) headers.set("content-type", "application/json");
        return rt.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
      },
    });
  } finally {
    await rt.close();
  }
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  body: JSON.stringify(body),
  headers,
});
const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));

/** An answer's status and its error's code (or its body). */
async function said(response: Response) {
  const body = await response.json().catch(() => null);
  return [response.status, body?.error?.code ?? body] as const;
}

test("REST: a caller's own reads and writes of a collection, within its rule, with their events", async () => {
  await setup(async ({ rt, as }) => {
    await rt.call("note.put", { _id: "b1", owner: "bob", text: "bob's" });
    const seen: string[] = [];
    const stop = rt.subscribe((item) => {
      if (item.kind === "event" && item.event.type.startsWith("note.")) {
        seen.push(`${item.event.type} ${item.event.actor?.id ?? "system"}`);
      }
    });
    // Inserted, as hers: where it is, said.
    const made = await as(ana, "/api/collections/note", json("POST", { owner: "ana", text: "a" }));
    assertEquals(made.status, 201);
    const { insertedId: id } = await made.json();
    assertEquals(made.headers.get("location"), `/api/collections/note/${id}`);
    // Out of her reach: refused.
    assertEquals(
      await said(await as(ana, "/api/collections/note", json("POST", { owner: "bob", text: "x" }))),
      [403, "forbidden"],
    );
    // The schema checks it.
    assertEquals(
      await said(await as(ana, "/api/collections/note", json("POST", { owner: "ana" }))),
      [400, "invalid"],
    );
    // What she reads: hers alone; one by id; filtered, sorted, counted.
    await as(ana, "/api/collections/note", json("POST", { _id: "a2", owner: "ana", text: "b" }));
    const all = await (await as(ana, "/api/collections/note")).json() as Note[];
    assertEquals(all.map((n) => n.text).sort(), ["a", "b"]);
    assertEquals((await (await as(ana, `/api/collections/note/${id}`)).json()).text, "a");
    assertEquals(await said(await as(ana, "/api/collections/note/b1")), [404, "not_found"]);
    const found = await as(
      ana,
      `/api/collections/note?filter=${q({ owner: "ana" })}&sort=${q({ text: -1 })}&limit=1`,
    );
    assertEquals((await found.json()).map((n: Note) => n.text), ["b"]);
    const skipped = await as(ana, `/api/collections/note?sort=${q({ text: 1 })}&skip=1`);
    assertEquals((await skipped.json()).map((n: Note) => n.text), ["b"]);
    assertEquals(await (await as(ana, "/api/collections/note?count=true")).json(), 2);
    // Updated: plain fields are set; an update document as it says.
    const patched = await as(ana, `/api/collections/note/${id}`, json("PATCH", { text: "a+" }));
    assertEquals((await patched.json()).matchedCount, 1);
    await as(ana, `/api/collections/note/${id}`, json("PATCH", { $set: { status: "draft" } }));
    assertEquals((await rt.call<Note>("note.get", { id })).text, "a+");
    // Someone else's: not there, for her. Out of reach afterwards: refused.
    assertEquals(
      await said(await as(ana, "/api/collections/note/b1", json("PATCH", { text: "mine" }))),
      [404, "not_found"],
    );
    assertEquals(
      await said(
        await as(ana, `/api/collections/note/${id}`, json("PATCH", { $set: { owner: "bob" } })),
      ),
      [403, "forbidden"],
    );
    // A write rule holds states: once locked, it's hers to read, not to change.
    assertEquals(
      await said(
        await as(ana, `/api/collections/note/${id}`, json("PATCH", { status: "locked" })),
      ),
      [403, "forbidden"],
    );
    // By filter: the first that matches, answered as MongoDB does (nothing matched isn't a 404).
    const byFilter = await as(
      ana,
      `/api/collections/note?filter=${q({ text: "nope" })}`,
      json("PATCH", { text: "x" }),
    );
    assertEquals([byFilter.status, (await byFilter.json()).matchedCount], [200, 0]);
    // Replaced; then deleted, once.
    const put = await as(ana, "/api/collections/note/a2", json("PUT", { owner: "ana", text: "c" }));
    assertEquals((await put.json()).matchedCount, 1);
    assertEquals((await rt.call<Note>("note.get", { id: "a2" })).text, "c");
    assertEquals(
      await said(
        await as(
          ana,
          "/api/collections/note/a2",
          json("PUT", { _id: "zz", owner: "ana", text: "" }),
        ),
      ),
      [400, "invalid"],
    );
    const gone = await as(ana, "/api/collections/note/a2", { method: "DELETE" });
    assertEquals((await gone.json()).deletedCount, 1);
    assertEquals(
      await said(await as(ana, "/api/collections/note/a2", { method: "DELETE" })),
      [404, "not_found"],
    );
    assertEquals(
      await said(await as(ana, "/api/collections/note/b1", { method: "DELETE" })),
      [404, "not_found"],
    );
    await rt.idle();
    stop();
    // Each write's events, as hers.
    assertEquals(seen, [
      "note.created ana",
      "note.created ana",
      "note.updated ana",
      "note.updated ana",
      "note.updated ana",
      "note.deleted ana",
    ]);
  });
});

test("REST: only where a rule speaks; never sys.*; private fields never read, filtered or written", async () => {
  await setup(async ({ rt, as }) => {
    await rt.call("note.put", { _id: "n1", owner: "ana", text: "a", secret: "s3cr3t" });
    // No rule speaks for the log: nobody outside reads or writes it.
    assertEquals(await said(await as(ana, "/api/collections/log")), [403, "forbidden"]);
    assertEquals(
      await said(await as(ana, "/api/collections/log", json("POST", { what: "x" }))),
      [403, "forbidden"],
    );
    assertEquals(await said(await as(ana, "/api/collections/sys.timers")), [403, "forbidden"]);
    assertEquals(await said(await as(ana, "/api/collections/nope")), [404, "not_found"]);
    // Read without it, never filtered or sorted by it.
    const read = await (await as(ana, "/api/collections/note/n1")).json();
    assertEquals(read, { _id: "n1", owner: "ana", text: "a" });
    for (
      const path of [
        `/api/collections/note?filter=${q({ secret: "s3cr3t" })}`,
        `/api/collections/note?filter=${q({ $or: [{ secret: { $exists: true } }] })}`,
        `/api/collections/note?sort=${q({ secret: 1 })}`,
      ]
    ) assertEquals(await said(await as(ana, path)), [403, "forbidden"], path);
    // Never written: inserted, set, unset, or renamed.
    for (
      const [method, path, body] of [
        ["POST", "/api/collections/note", { owner: "ana", text: "b", secret: "mine" }],
        ["PATCH", "/api/collections/note/n1", { secret: "mine" }],
        ["PATCH", "/api/collections/note/n1", { $unset: { secret: "" } }],
        ["PATCH", "/api/collections/note/n1", { $rename: { text: "secret" } }],
        ["PUT", "/api/collections/note/n1", { owner: "ana", text: "c", secret: "mine" }],
      ] as const
    ) {
      assertEquals(await said(await as(ana, path, json(method, body))), [403, "forbidden"], path);
    }
    // A replacement keeps what it can't write.
    await as(ana, "/api/collections/note/n1", json("PUT", { owner: "ana", text: "replaced" }));
    assertEquals(await rt.call("note.get", { id: "n1" }), {
      _id: "n1",
      owner: "ana",
      text: "replaced",
      secret: "s3cr3t",
    });
  });
});

test("REST: a caller's scope, checked where it comes in", async () => {
  await setup(async ({ rt, as }) => {
    await rt.call("note.put", { _id: "n1", owner: "ana", text: "a" });
    // A reader reads, and no more.
    assertEquals((await (await as(reader, "/api/collections/note")).json()).length, 1);
    assertEquals(
      await said(
        await as(reader, "/api/collections/note", json("POST", { owner: "ana", text: "x" })),
      ),
      [403, "forbidden"],
    );
    assertEquals(
      await said(await as(reader, "/api/collections/note/n1", { method: "DELETE" })),
      [403, "forbidden"],
    );
    assertEquals(
      await said(await as(reader, "/api/actions/note.add", json("POST", { text: "x" }))),
      [403, "forbidden"],
    );
    assertEquals(await said(await as(reader, "/api/queries/note.mine")), [403, "forbidden"]);
    assertEquals(await (await as(reader, "/api/views/note.count")).json(), "1 notes");
    // A writer writes, calls and queries what it lists; emits nothing; sees no View it doesn't list.
    assertEquals(
      (await as(writer, "/api/collections/note", json("POST", { owner: "ana", text: "w" }))).status,
      201,
    );
    assertEquals(
      (await as(writer, "/api/actions/note.add", json("POST", { text: "y" }))).status,
      200,
    );
    assertEquals((await (await as(writer, "/api/queries/note.mine")).json()).length, 3);
    assertEquals(
      await said(await as(writer, "/api/events/note.seen", json("POST", {}))),
      [403, "forbidden"],
    );
    assertEquals(await said(await as(writer, "/api/views/note.count")), [403, "forbidden"]);
    // Ana herself emits, as the event lets her.
    assertEquals((await as(ana, "/api/events/note.seen", json("POST", {}))).status, 204);
  });
});

test("REST: calls by the caller's own id: sent again, answered as the first, done once", async () => {
  await setup(async ({ rt, as }) => {
    const once = (actor: Actor | null, text: string, key = "order-42") =>
      as(actor, "/api/actions/note.add", json("POST", { text }, { "idempotency-key": key }));
    const first = await (await once(ana, "once")).json();
    assertEquals(await (await once(ana, "once")).json(), first);
    assertEquals((await rt.query<Note[]>("note.all")).length, 1);
    // The same id for something else: a conflict.
    assertEquals(await said(await once(ana, "else")), [409, "id_conflict"]);
    // Someone else's same id is theirs; so is a key's, apart from its person.
    const bobs = await (await once(bob, "once")).json();
    assert(bobs.note !== first.note);
    const keys = await (await once(writer, "once")).json();
    assert(keys.note !== first.note && keys.note !== bobs.note);
    assertEquals(await said(await once(ana, "x", "")), [400, "invalid"]);
    // Nobody has nothing to tell their calls apart by.
    assertEquals(await said(await once(null, "x")), [400, "invalid"]);
  });
});

/** Reads a server-sent stream until `until` holds of what came, each event's name and data. */
async function follow(
  response: Response,
  until: (events: { event: string; data: unknown }[]) => boolean,
) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = "";
  const deadline = Date.now() + 5_000;
  while (!until(events)) {
    const left = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        timer = setTimeout(
          () => reject(new Error(`Still waiting; got ${JSON.stringify(events)}`)),
          Math.max(left, 0),
        )
      ),
    ]).finally(() => clearTimeout(timer)).catch(async (error) => {
      await reader.cancel();
      throw error;
    });
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) {
        events.push({
          event: /^event: (.*)$/m.exec(block)?.[1] ?? "message",
          data: JSON.parse(data),
        });
      }
    }
  }
  await reader.cancel();
  return events;
}

const watching = { headers: { accept: "text/event-stream" } };

test("REST: a watch sends the result, then each new one after a commit that changes it", async () => {
  await setup(async ({ rt, as }) => {
    const stream = await as(ana, `/api/collections/note?sort=${q({ text: 1 })}`, watching);
    assertEquals(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const texts = (events: { data: unknown }[]) =>
      events.map((e) => (e.data as Note[]).map((n) => n.text));
    const shown = follow(stream, (events) => events.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Bob's never shows; hers do, as they come.
    await rt.call("note.add", { text: "bob's" }, { actor: bob });
    await as(ana, "/api/collections/note", json("POST", { owner: "ana", text: "b" }));
    await rt.call("note.add", { text: "a" }, { actor: ana });
    assertEquals(texts(await shown), [[], ["b"], ["a", "b"]]);
    // A query's and a View's, too; and a count.
    const count = follow(
      await as(ana, "/api/collections/note?count=true", watching),
      (e) => e.length >= 2,
    );
    const view = follow(await as(reader, "/api/views/note.count", watching), (e) => e.length >= 2);
    const query = follow(await as(ana, "/api/queries/note.mine", watching), (e) => e.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rt.call("note.add", { text: "c" }, { actor: ana });
    assertEquals((await count).map((e) => e.data), [2, 3]);
    assertEquals((await view).map((e) => e.data), ["2 notes", "3 notes"]);
    assertEquals((await query).map((e) => (e.data as Note[]).length), [2, 3]);
    // Refused before it starts: an error, not a stream.
    assertEquals(await said(await as(ana, "/api/collections/log", watching)), [403, "forbidden"]);
  });
});

test("REST: the events stream says what the caller reaches, and its own calls' outcomes", async () => {
  await setup(async ({ rt, as }) => {
    const stream = await as(writer, "/api/events");
    const events = follow(stream, (seen) => seen.some((e) => e.event === "action.completed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rt.call("note.put", { _id: "b1", owner: "bob", text: "bob's" });
    await rt.call("note.put", { _id: "a1", owner: "ana", text: "hers", secret: "s3cr3t" });
    await rt.call("note.put", { _id: "l1", owner: "ana", text: "locked", status: "locked" });
    await as(writer, "/api/actions/note.add", json("POST", { text: "by key" }));
    const said = await events;
    const notes = said.filter((e) => e.event === "note.created").map((e) =>
      (e.data as { doc: Note }).doc
    );
    // Hers, including what she reads but can't change; never Bob's, nor a private field.
    assertEquals(notes.map((n) => n.text), ["hers", "locked", "by key"]);
    assert(!JSON.stringify(said).includes("s3cr3t"));
    // Its own call's outcome, by call id.
    const done = said.find((e) => e.event === "action.completed")!.data as Record<string, unknown>;
    assertEquals([done.action, typeof done.call], ["note.add", "string"]);
    assert((done.result as { note: string }).note);
  });
});

test("REST: streams end at once when their actor is ended, and at the ping when who changes", async () => {
  await setup(async ({ rt, as }) => {
    const events = await as(writer, "/api/events");
    const ended = follow(events, (seen) => seen.some((e) => e.event === "revoked"));
    const watch = await as(writer, "/api/collections/note", watching);
    const stopped = follow(watch, (seen) => seen.some((e) => e.event === "revoked"));
    // Its person's own stream goes on.
    const hers = await as(ana, "/api/collections/note", watching);
    assertEquals(rt.disconnect(writer), 0);
    assertEquals((await ended).at(-1)?.event, "revoked");
    assertEquals((await stopped).at(-1)?.event, "revoked");
    const still = hers.body!.getReader();
    assert(!(await still.read()).done);
    await still.cancel();
  });
  // The ping asks who the request is now: a credential that proves someone else (or nobody) ends it.
  const clock = manualClock();
  const rt = await createRuntime({
    store: memoryStore(),
    clock,
    plugins: [
      notes,
      definePlugin({
        name: "who",
        // Who the request is: whom the header names, while the list says so.
        who: (request) => {
          const name = request.headers.get("x-name");
          return name && current.has(name) ? { kind: "person", id: name } : null;
        },
      }),
    ],
  });
  const current = new Set(["ana"]);
  try {
    const stream = await rt.fetch(
      new Request("http://localhost/api/events", { headers: { "x-name": "ana" } }),
    );
    const ended = follow(stream, (seen) => seen.some((e) => e.event === "revoked"));
    // Signed out some other way than ending her (nothing tells the stream): its next ping finds it.
    current.delete("ana");
    clock.advance(20_000);
    assertEquals((await ended).at(-1)?.data, {
      error: { code: "unauthorized", message: "No longer signed in, or the key was revoked." },
    });
  } finally {
    await rt.close();
  }
});

test("REST: the reference says what this caller may use", async () => {
  await setup(async ({ as }) => {
    const scoped = await (await as(writer, "/api/")).json();
    assertEquals(scoped.actor, { kind: "person", id: "ana", key: "k1" });
    assertEquals(scoped.actions.map((a: { name: string }) => a.name), ["note.add"]);
    assertEquals(scoped.actions[0].input.required, ["text"]);
    assertEquals(scoped.queries, [
      { name: "note.mine", method: "POST", path: "/api/queries/note.mine" },
    ]);
    assertEquals(scoped.collections, [
      { name: "note", read: true, write: true, path: "/api/collections/note" },
    ]);
    // Unscoped: what lets someone in from outside, and what a rule speaks for, for them.
    const hers = await (await as(ana, "/api/")).json();
    assertEquals(hers.actions.map((a: { name: string }) => a.name), ["note.add"]);
    assertEquals(hers.queries.map((q: { name: string }) => q.name), ["note.mine"]);
    assertEquals(hers.views.map((v: { name: string }) => v.name), ["note.count"]);
    assertEquals(hers.collections.map((c: { name: string }) => c.name), ["note"]);
    // Nobody: told how to be someone.
    const nobody = await as(null, "/api/");
    assertEquals(nobody.status, 401);
    assertEquals(nobody.headers.get("www-authenticate"), 'Bearer realm="api"');
  });
});

test("REST: errors are JSON with their code's status; a credential proving nobody is a 401", async () => {
  await setup(async ({ as, rt }) => {
    assertEquals(await said(await as(ana, "/api/actions/nope", json("POST", {}))), [
      404,
      "not_found",
    ]);
    assertEquals(await said(await as(ana, "/api/actions/note.add", json("POST", { text: 3 }))), [
      400,
      "invalid",
    ]);
    const garbled = await as(ana, "/api/actions/note.add", { method: "POST", body: "{nope" });
    assertEquals((await garbled.json()).error, {
      code: "invalid",
      message: "The body isn't JSON.",
    });
    const wrong = await as(ana, "/api/actions/note.add");
    assertEquals([wrong.status, wrong.headers.get("allow")], [405, "POST"]);
    assertEquals(await said(await as(ana, "/api/elsewhere")), [404, "not_found"]);
    assertEquals(await said(await as(ana, "/api/queries/note.nope")), [404, "not_found"]);
    assertEquals(await said(await as(ana, "/api/views/nope")), [404, "not_found"]);
    // The system's alone: refused; to nobody, a 401 that says how to be someone.
    assertEquals(await said(await as(ana, "/api/actions/note.put", json("POST", {}))), [
      403,
      "forbidden",
    ]);
    const nobody = await as(null, "/api/actions/note.add", json("POST", { text: "x" }));
    assertEquals([nobody.status, nobody.headers.get("www-authenticate")], [
      401,
      'Bearer realm="api"',
    ]);
    const bad = await rt.fetch(
      new Request("http://localhost/api/collections/note", {
        headers: { authorization: "Bearer cpz_nope" },
      }),
    );
    assertEquals(await said(bad), [401, "unauthorized"]);
    // Any origin may call with a key.
    const options = await as(null, "/api/actions/note.add", { method: "OPTIONS" });
    assertEquals(options.headers.get("access-control-allow-origin"), "*");
    assertMatch(options.headers.get("access-control-allow-methods")!, /PATCH/);
  });
});

test("the socket's writes: as the person's own, within the rules and the scope", async () => {
  const topic = `api-socket.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [notes, testWho],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const open = (actor: Actor) =>
    connect({
      transport: { type: "in-process", config: { topic } },
      ticket: () => ticketFor(rt, actor),
      plugins: [],
    });
  const [hers, keyed, read] = [open(ana), open(writer), open(reader)];
  try {
    await Promise.all([hers.ready, keyed.ready, read.ready]);
    const notes = hers.db.collection<Note>("note");
    const { insertedId } = await notes.insertOne({ owner: "ana", text: "a" });
    assertEquals((await notes.findOne({ _id: insertedId }))?.text, "a");
    assertEquals(
      (await notes.updateOne({ _id: insertedId }, { $set: { text: "b" } })).modifiedCount,
      1,
    );
    // Out of reach, private, unruled: refused, as over REST.
    const refused = async (work: Promise<unknown>) => {
      const error = await work.then(() => undefined, (e) => e);
      assertEquals(error?.code, "forbidden", String(error));
    };
    await refused(notes.insertOne({ owner: "bob", text: "x" }));
    await refused(notes.updateOne({ _id: insertedId }, { $set: { secret: "x" } }));
    await refused(hers.db.collection("log").insertOne({ what: "x" }));
    // The scope: a key that only reads writes nothing; one that writes does.
    await refused(read.db.collection<Note>("note").insertOne({ owner: "ana", text: "x" }));
    assertEquals(await read.db.collection("note").countDocuments(), 1);
    await keyed.db.collection<Note>("note").insertOne({ owner: "ana", text: "k" });
    assertEquals((await notes.find({}, { sort: { text: 1 } }).toArray()).map((n) => n.text), [
      "b",
      "k",
    ]);
    assertEquals((await notes.deleteOne({ _id: insertedId })).deletedCount, 1);
    // Its own call id: done once.
    const first = await hers.call("note.add", { text: "once" }, { id: "x1" });
    assertEquals(await hers.call("note.add", { text: "once" }, { id: "x1" }), first);
    assertEquals(await notes.countDocuments({ text: "once" }), 1);
  } finally {
    await Promise.all([hers.close(), keyed.close(), read.close()]);
    await rt.close();
  }
});
