/**
 * The developer API: keys (made by a person in a space, shown once, kept
 * as a hash, revoked), and calls with them over HTTP: as the key's person,
 * only in its space and only what it lists; Idempotency-Key as the call
 * id; JSON errors; queries, Views, the reference, and events as they
 * happen, of what the key may see.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, type Thread } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { api, type ApiKey, serveApi } from "../mod.ts";
import { test } from "../../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** Answers what it was told, at once. */
const echo: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => m.role === "user");
    yield { type: "text", text: `heard: ${last && "text" in last ? last.text : ""}` };
  },
};

/** Notes in spaces, one with a field nobody outside reads. */
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text: { type: "string" }, in: { type: "string" } } },
      private: ["secret"],
      queries: {
        list: {
          allow: (actor) => actor.kind === "person",
          run: (notes) => notes.find({}, { sort: { text: 1 } }),
        },
      },
    }),
  },
  actions: {
    "note.write": defineAction({
      input: {
        type: "object",
        properties: { text: { type: "string" }, in: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const _id = crypto.randomUUID();
        await ctx.db.collection("note").insertOne({ _id, ...input, secret: "s3cr3t" });
        return { note: _id };
      },
    }),
    // Reads as an agent working for whoever calls: what its turns would reach.
    "note.agent": defineAction({
      input: { type: "object" },
      allow: (actor) => actor.kind === "person",
      run: async (ctx) =>
        (await ctx.as({ kind: "agent", id: "lead", for: ctx.actor })
          .db.collection<{ text: string }>("note").find({}, { sort: { text: 1 } }))
          .map((n) => n.text),
    }),
    // The system's alone: no `allow`.
    "note.wipe": defineAction({ input: { type: "object" }, run: () => ({ wiped: true }) }),
  },
  views: {
    "note.count": {
      llm: (_: unknown, ctx: ViewContext) =>
        `${ctx.db.collection("note").countDocuments({}).value ?? 0} notes`,
    },
  },
});

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {}, note: {} },
    provider: { e: { adapter: "e" } },
    agents: { lead: { instructions: "Hi.", model: "e/lead", default: true } },
  },
  adapters: { llm: { e: echo } },
});

type Setup = {
  runtime: Runtime;
  serve(request: Request): Promise<Response>;
  /** Ana's Personal space, and a shared one she made. */
  personal: string;
  launch: string;
  /** A key's secret, made by Ana in a space. */
  key(input?: Record<string, unknown>): Promise<string>;
  call(secret: string, path: string, init?: RequestInit): Promise<Response>;
};

async function setup(fn: (s: Setup) => Promise<void>, whom: Actor | null = null) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, api, notes, app],
  });
  try {
    const { space: personal } = await runtime.call<{ space: string }>(
      "space.personal",
      {},
      { actor: ana },
    );
    const { space: launch } = await runtime.call<{ space: string }>(
      "space.create",
      { name: "Launch" },
      { actor: ana },
    );
    const serve = (request: Request) =>
      serveApi(request, { runtime, whom: () => Promise.resolve(whom) });
    await fn({
      runtime,
      serve,
      personal,
      launch,
      key: async (input = {}) =>
        (await runtime.call<{ key: string }>("api_key.create", {
          in: personal,
          name: "Script",
          actions: ["chat.send", "note.write", "note.agent", "note.wipe"],
          queries: ["note.list", "thread.recent", "message.conversation"],
          ...input,
        }, { actor: ana })).key,
      call: (secret, path, init = {}) =>
        serve(
          new Request(`http://localhost${path}`, {
            ...init,
            headers: {
              authorization: `Bearer ${secret}`,
              ...(init.body ? { "content-type": "application/json" } : {}),
              ...init.headers,
            },
          }),
        ),
    });
  } finally {
    await runtime.close();
  }
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers,
});

/** Every event's data, as text: what the log holds. */
async function logged(runtime: Runtime, during: () => Promise<void>): Promise<string> {
  const seen: unknown[] = [];
  const stop = runtime.subscribe((item) => {
    if (item.kind === "event") seen.push(item.event);
  });
  try {
    await during();
    await runtime.idle();
  } finally {
    stop();
  }
  return JSON.stringify(seen);
}

test("a key is shown once, kept as a hash, its person's alone, and revoked", async () => {
  await setup(async ({ runtime, personal, key, call }) => {
    let secret = "";
    const log = await logged(runtime, async () => {
      secret = await key();
    });
    assertMatch(secret, /^cpz_[\w-]{43}$/);
    // The log has who made it, and never its secret.
    assert(log.includes("api_key.created"));
    assert(!log.includes(secret));
    const [mine] = await runtime.query<ApiKey[]>("api_key.mine", { in: personal }, { actor: ana });
    assertEquals([mine.name, mine.in, mine.hint, mine.person], [
      "Script",
      personal,
      secret.slice(0, 8),
      "ana",
    ]);
    assert(!JSON.stringify(mine).includes(secret));
    assertEquals(await runtime.query("api_key.mine", {}, { actor: bob }), []);
    // Nobody else revokes it; she does.
    assertEquals(await runtime.call("api_key.revoke", { key: mine._id }, { actor: bob }), {
      revoked: 0,
    });
    assertEquals((await call(secret, "/api/")).status, 200);
    assertEquals(await runtime.call("api_key.revoke", { key: mine._id }, { actor: ana }), {
      revoked: 1,
    });
    const revoked = await call(secret, "/api/");
    assertEquals(revoked.status, 401);
    assertEquals((await revoked.json()).error.code, "unauthorized");
  });
});

test("a key is made only in a space its person is in, for something, and never by a key", async () => {
  await setup(async ({ runtime, launch, key, call }) => {
    await assertRejects(() => key({ in: "nowhere" }), Error, "aren't in that space");
    await assertRejects(
      () =>
        runtime.call("api_key.create", { in: launch, name: "x", actions: ["chat.send"] }, {
          actor: bob,
        }),
      Error,
      "aren't in that space",
    );
    await assertRejects(
      () => key({ actions: [], queries: [] }),
      Error,
      "pick at least one",
    );
    const secret = await key({ actions: ["api_key.create"] });
    const made = await call(secret, "/api/actions/api_key.create", post({ name: "more" }));
    assertEquals(made.status, 403);
  });
});

test("a call acts as the key's person, in its space, and only for what it lists", async () => {
  await setup(async ({ runtime, personal, key, call }) => {
    const secret = await key();
    // Without a key, or with a wrong one: 401.
    assertEquals((await call("cpz_nope", "/api/")).status, 401);
    const anonymous = await serveApiAnonymously(runtime);
    assertEquals(anonymous.status, 401);
    assertEquals(anonymous.headers.get("www-authenticate"), 'Bearer realm="api"');

    const sent = await call(secret, "/api/actions/chat.send", post({ text: "hello" }));
    assertEquals(sent.status, 200);
    const { thread } = await sent.json() as { thread: string };
    await runtime.idle();
    // It went where the key works, as Ana, and her agent answered her.
    const t = (await runtime.query<Thread[]>("thread.recent", { in: personal }, { actor: ana }))[0];
    assertEquals([t._id, t.in], [thread, personal]);
    const said = await runtime.query<Message[]>("message.history", { thread }, { actor: ana });
    assertEquals(said.map((m) => [m.from, m.text]), [["ana", "hello"], [
      "lead",
      "heard: ana: hello",
    ]]);

    // Not on its list: refused, before anything runs.
    const stopped = await call(secret, "/api/actions/chat.stop", post({ thread }));
    assertEquals(stopped.status, 403);
    assertEquals((await stopped.json()).error.code, "forbidden");
    // On its list, but the system's alone: the runtime refuses it too.
    const wiped = await call(secret, "/api/actions/note.wipe", post({}));
    assertEquals(wiped.status, 403);
    // Not there at all; bad input; not JSON; the wrong method.
    assertEquals((await call(secret, "/api/actions/nope", post({}))).status, 403);
    const bad = await call(secret, "/api/actions/chat.send", post({ text: 3 }));
    assertEquals([bad.status, (await bad.json()).error.code], [400, "invalid"]);
    const garbled = await call(secret, "/api/actions/chat.send", {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    assertEquals((await garbled.json()).error, {
      code: "invalid",
      message: "The body isn't JSON.",
    });
    assertEquals((await call(secret, "/api/actions/chat.send")).status, 405);
    assertEquals((await call(secret, "/api/elsewhere")).status, 404);
  });
});

/** A request with no key at all. */
const serveApiAnonymously = (runtime: Runtime) =>
  serveApi(new Request("http://localhost/api/actions/chat.send", { method: "POST" }), {
    runtime,
    whom: () => Promise.resolve(null),
  });

test("a key reaches its space alone: not its person's others, nor through their agents", async () => {
  await setup(async ({ runtime, personal, launch, key, call }) => {
    await runtime.call("note.write", { text: "launch plan", in: launch }, { actor: ana });
    await runtime.call("note.write", { text: "diary", in: personal }, { actor: ana });
    const secret = await key({ in: launch });
    const listed = await call(secret, "/api/queries/note.list", post({}));
    assertEquals((await listed.json() as { text: string }[]).map((n) => n.text), ["launch plan"]);
    // Ana herself reaches both.
    assertEquals(
      (await runtime.query<{ text: string }[]>("note.list", {}, { actor: ana })).length,
      2,
    );
    // An agent working for the key: the key's space too.
    const agent = await call(secret, "/api/actions/note.agent", post({}));
    assertEquals(await agent.json(), ["launch plan"]);
    // Writing elsewhere is refused; where it works, by default.
    const elsewhere = await call(
      secret,
      "/api/actions/note.write",
      post({ text: "x", in: personal }),
    );
    assertEquals(elsewhere.status, 403);
    const here = await call(secret, "/api/actions/note.write", post({ text: "from code" }));
    assertEquals(here.status, 200);
    assertEquals(
      (await runtime.query<{ text: string; in: string }[]>("note.list", {}, { actor: ana }))
        .filter((n) => n.text === "from code").map((n) => n.in),
      [launch],
    );
    // Private fields stay out of what it reads.
    const read = await (await call(secret, "/api/queries/note.list", post({}))).json();
    assert(!JSON.stringify(read).includes("s3cr3t"));
    // Not on its list.
    assertEquals((await call(secret, "/api/queries/message.history", post({}))).status, 403);
    // Its person left the space: the key reaches nothing there.
    await runtime.call("person.set", { person: "bob", email: "bob@example.com" });
    const { invitation } = await runtime.call<{ invitation: string }>("invitation.send", {
      space: launch,
      email: "bob@example.com",
      role: "manager",
    }, { actor: ana });
    await runtime.call("invitation.accept", { invitation }, { actor: bob });
    await runtime.call("space.leave", { space: launch }, { actor: ana });
    assertEquals(await (await call(secret, "/api/queries/note.list", post({}))).json(), []);
  });
});

test("an Idempotency-Key makes the call's id: sent again, it answers the first, done once", async () => {
  await setup(async ({ runtime, personal, key, call }) => {
    const secret = await key();
    const once = post({ text: "only once" }, { "idempotency-key": "order-42" });
    const first = await (await call(secret, "/api/actions/chat.send", once)).json();
    const again = await (await call(secret, "/api/actions/chat.send", once)).json();
    assertEquals(again, first);
    await runtime.idle();
    const threads = await runtime.query<Thread[]>("thread.recent", { in: personal }, {
      actor: ana,
    });
    assertEquals(threads.length, 1);
    // The same key with something else: a conflict.
    const other = await call(
      secret,
      "/api/actions/chat.send",
      post({ text: "something else" }, { "idempotency-key": "order-42" }),
    );
    assertEquals([other.status, (await other.json()).error.code], [409, "id_conflict"]);
    // Another key's same Idempotency-Key is its own.
    const second = await key({ name: "Other" });
    const theirs = await call(second, "/api/actions/chat.send", once);
    assertEquals(theirs.status, 200);
    assert((await theirs.json()).thread !== first.thread);
    const bad = await call(
      secret,
      "/api/actions/chat.send",
      post({ text: "x" }, {
        "idempotency-key": "",
      }),
    );
    assertEquals(bad.status, 400);
  });
});

test("the reference: what the key may call, each Action's input as declared", async () => {
  await setup(async ({ key, call, launch }) => {
    const secret = await key({ in: launch, actions: ["note.write", "nope"], views: ["thread"] });
    const reference = await (await call(secret, "/api/")).json();
    assertEquals(reference.key, { name: "Script", in: launch, hint: secret.slice(0, 8) });
    assertEquals(reference.actions.map((a: { name: string }) => a.name), ["note.write"]);
    assertEquals(reference.actions[0].path, "/api/actions/note.write");
    assertEquals(reference.actions[0].input.required, ["text"]);
    assertEquals(
      reference.queries.map((q: { path: string }) => q.path),
      ["/api/queries/note.list", "/api/queries/thread.recent", "/api/queries/message.conversation"],
    );
    assertEquals(reference.views, [{ name: "thread", method: "GET", path: "/api/views/thread" }]);
  });
});

test("from the app's page, signed in, the catalog of Actions; nobody else", async () => {
  await setup(async ({ serve }) => {
    const catalog = await (await serve(new Request("http://localhost/api/"))).json();
    const names = catalog.actions.map((a: { name: string }) => a.name);
    assert(names.includes("chat.send") && names.includes("note.write"));
    assertEquals(names, [...names].sort((a: string, b: string) => a.localeCompare(b)));
  }, ana);
  await setup(async ({ serve }) => {
    assertEquals((await serve(new Request("http://localhost/api/"))).status, 401);
  });
});

test("a key's last use is noted, at most once a minute", async () => {
  await setup(async ({ runtime, key, call }) => {
    const secret = await key();
    const [before] = await runtime.query<ApiKey[]>("api_key.mine", {}, { actor: ana });
    assertEquals(before.used, undefined);
    await call(secret, "/api/");
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [after] = await runtime.query<ApiKey[]>("api_key.mine", {}, { actor: ana });
    assert(after.used && Date.now() - Date.parse(after.used) < 5_000);
  });
});

test("a View, as the key reads it: once, or as it changes", async () => {
  await setup(async ({ runtime, personal, launch, key, call }) => {
    await runtime.call("note.write", { text: "a", in: launch }, { actor: ana });
    await runtime.call("note.write", { text: "b", in: personal }, { actor: ana });
    const secret = await key({ in: launch, views: ["note.count"] });
    const shown = await call(secret, "/api/views/note.count");
    assertEquals(await shown.json(), "1 notes");
    assertEquals((await call(secret, "/api/views/thread")).status, 403);
    const followed = await call(secret, "/api/views/note.count?follow=1");
    const reader = followed.body!.pipeThrough(new TextDecoderStream()).getReader();
    let said = "";
    const next = async (until: string) => {
      while (!said.includes(until)) said += (await reader.read()).value ?? "";
    };
    await next('data: "1 notes"');
    await runtime.call("note.write", { text: "c", in: launch }, { actor: ana });
    await next('data: "2 notes"');
    await reader.cancel();
  });
});

/** Reads server-sent events until `until` says it has what it waits for. */
async function follow(
  response: Response,
  until: (events: { event: string; data: Record<string, unknown> }[]) => boolean,
) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let buffer = "";
  const deadline = Date.now() + 5_000;
  while (!until(events)) {
    if (Date.now() > deadline) throw new Error(`Still waiting; got ${JSON.stringify(events)}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

test("events: what happens in the key's space as it happens, as the key reads it", async () => {
  await setup(async ({ runtime, personal, launch, key, call }) => {
    const secret = await key({ in: launch });
    const stream = await call(secret, "/api/events");
    assertEquals(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    // Elsewhere: never shown. Here: shown, without what's private.
    await runtime.call("note.write", { text: "diary", in: personal }, { actor: ana });
    await runtime.call("note.write", { text: "plan", in: launch }, { actor: ana });
    const sent = await call(secret, "/api/actions/chat.send", post({ text: "go" }));
    assertEquals(sent.status, 200);
    const events = await follow(
      stream,
      (seen) =>
        seen.some((e) => e.event === "message.created" && (e.data.doc as Message).from === "lead"),
    );
    const notes = events.filter((e) => e.event === "note.created");
    assertEquals(notes.map((e) => (e.data.doc as { text: string }).text), ["plan"]);
    assert(!JSON.stringify(events).includes("s3cr3t"));
    assert(!JSON.stringify(events).includes("diary"));
    const replies = events.filter((e) => e.event === "message.created")
      .map((e) => (e.data.doc as Message).text);
    assertEquals(replies, ["go", "heard: ana: go"]);
    // Its own call's outcome, by call id; not those of the calls it made in turn.
    const done = events.filter((e) => e.event === "action.completed");
    assertEquals(done.map((e) => e.data.action), ["chat.send"]);
    assert(typeof done[0].data.call === "string");
  });
});

test("events end, saying so, once the key is revoked", async () => {
  await setup(async ({ runtime, key, call }) => {
    const secret = await key();
    const stream = await call(secret, "/api/events");
    const [mine] = await runtime.query<ApiKey[]>("api_key.mine", {}, { actor: ana });
    await runtime.call("api_key.revoke", { key: mine._id }, { actor: ana });
    // The check runs with the ping: here, sooner.
    const { eventStream } = await import("../shared/events.ts");
    const proven = { key: mine, actor: { kind: "person" as const, id: "ana", key: "k", at: "x" } };
    const fast = eventStream(runtime, proven, () => Promise.resolve(false), 10);
    const said = await follow(fast, (seen) => seen.some((e) => e.event === "revoked"));
    assertEquals(said.at(-1)?.data, {
      error: { code: "unauthorized", message: "The key was revoked." },
    });
    await stream.body?.cancel();
  });
});
