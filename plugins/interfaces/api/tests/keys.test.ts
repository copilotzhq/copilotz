/**
 * Developer keys as members: a key is a member of its space (`key:<id>`),
 * its role following from its scope (presets included), and reaches what
 * both its membership and its person reach, never by an org role: an
 * admin's key reaches only its space. Keys show among the space's members,
 * where its managers revoke them; revoked, a key's connections close, and
 * its person's stay.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type Scope,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { api, type ApiKey, type KeyActor, roleOf } from "../mod.ts";
import { presets } from "../resources/presets.ts";
import { test, testWho, ticketFor } from "../../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };

const echo: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "ok" };
  },
};

const person = (actor: Actor) => actor.kind === "person";

/** Notes in spaces, a View of them, and a View of the keys a space's people read. */
const app = definePlugin({
  name: "app",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text: { type: "string" }, in: { type: "string" } } },
      queries: {
        texts: {
          allow: person,
          run: async (notes) => (await notes.find({}, { sort: { text: 1 } })).map((n) => n.text),
        },
      },
    }),
  },
  actions: {
    "note.write": defineAction({
      input: {
        type: "object",
        properties: { text: { type: "string" }, in: { type: "string" } },
        required: ["text", "in"],
      },
      allow: person,
      run: (ctx, input) => ctx.db.collection("note").insertOne(input).then(() => ({ ok: true })),
    }),
    // Who's in a space, as the system reads it.
    "test.members": defineAction({
      input: { type: "object", properties: { space: { type: "string" } }, required: ["space"] },
      record: false,
      run: (ctx, input) => ctx.db.collection("member").find({ space: input.space }),
    }),
  },
  views: {
    "test.keys": (item: { in: string }, ctx: ViewContext) =>
      (ctx.db.collection<ApiKey>("api_key").find({ in: item.in }).value ?? []).map((k) => k.name),
  },
  resources: {
    shared: { thread: {}, message: {}, note: {} },
    provider: { e: { adapter: "e" } },
    agents: { lead: { instructions: "Hi.", model: "e/lead", default: true } },
  },
  adapters: { llm: { e: echo } },
});

type Setup = {
  runtime: Runtime;
  /** A client connected as `actor`, as a browser or a script on the socket is. */
  as(actor: Actor): ReturnType<typeof connect>;
  /** A client connected with a key's secret, as a script is: `/connect` with it as a bearer. */
  bearing(secret: string): ReturnType<typeof connect>;
  /** A key made by `by` in `space`, for `scope`: its id, its secret and who calling with it is. */
  key(
    by: Actor,
    space: string,
    scope: Scope,
    name?: string,
  ): Promise<{ id: string; secret: string; actor: KeyActor }>;
  /** `who` joins `space` with `role`, invited by `by`. */
  join(space: string, who: Actor, role: string, by: Actor): Promise<void>;
  /** A key's role in a space, as its membership says. */
  role(space: string, key: string): Promise<string | undefined>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const topic = `keys-test.${crypto.randomUUID()}`;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, api, app, testWho],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const clients: ReturnType<typeof connect>[] = [];
  try {
    for (const p of [ana, bob, cy]) {
      await runtime.call("person.set", { person: p.id, email: `${p.id}@example.com` });
    }
    await fn({
      runtime,
      as: (actor) => {
        const client = connect({
          transport: { type: "in-process", config: { topic } },
          // A ticket from the runtime's /connect: only while the key (if it's one) still works.
          ticket: async () => {
            const key = typeof actor.key === "string" ? actor.key : undefined;
            if (key && !await runtime.query("api_key.get", { key })) throw new Error("Revoked");
            return await ticketFor(runtime, actor);
          },
          plugins: [],
        });
        clients.push(client);
        return client;
      },
      bearing: (secret) => {
        const client = connect({
          transport: { type: "in-process", config: { topic } },
          ticket: async () => {
            const answered = await runtime.fetch(bearer("/connect", secret));
            if (!answered.ok) throw new Error(`/connect answered ${answered.status}`);
            return (await answered.json() as { ticket: string }).ticket;
          },
          plugins: [],
        });
        clients.push(client);
        return client;
      },
      key: async (by, space, scope, name = "Script") => {
        const made = await runtime.call<{ key: string; id: string }>("api_key.create", {
          in: space,
          name,
          scope,
        }, { actor: by });
        const actor = await runtime.query<KeyActor>("api_key.actor", { secret: made.key });
        return { id: made.id, secret: made.key, actor };
      },
      join: async (space, who, role, by) => {
        const { invitation } = await runtime.call<{ invitation: string }>("invitation.send", {
          space,
          email: `${who.id}@example.com`,
          role,
        }, { actor: by });
        await runtime.call("invitation.accept", { invitation }, { actor: who });
      },
      role: async (space, key) =>
        (await runtime.call<{ member: string; role: string }[]>("test.members", { space }))
          .find((m) => m.member === `key:${key}`)?.role,
    });
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await runtime.close();
  }
}

/** A POST to the runtime with a key's secret as its bearer, as a script sends it. */
const bearer = (path: string, secret: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** What a View observed once as `actor` comes to. */
async function shown(runtime: Runtime, kind: string, item: unknown, actor: Actor) {
  const observed = runtime.observe(kind, item, { actor });
  const out = await observed.ready;
  observed.close();
  return out.status === "ready" ? out.value : out.status;
}

const space = async (runtime: Runtime, name: string, by: Actor) =>
  (await runtime.call<{ space: string }>("space.create", { name }, { actor: by })).space;

test("presets: each a scope, its role following: Chat an editor, Read only a viewer", async () => {
  assertEquals(presets.chat.scope, {
    call: ["chat.send", "chat.stop"],
    query: ["thread.recent", "message.conversation"],
  });
  assertEquals(presets.read.scope, {
    query: ["thread.recent", "message.conversation", "message.history"],
  });
  assertEquals([roleOf(presets.chat.scope), roleOf(presets.read.scope)], ["editor", "viewer"]);
  // Writing makes an editor too; reading alone, a viewer.
  assertEquals(roleOf({ write: ["note"] }), "editor");
  assertEquals(roleOf({ read: ["note"], view: ["thread"] }), "viewer");
  // Made with them, a key is a member with that role.
  await setup(async ({ runtime, key, role }) => {
    const launch = await space(runtime, "Launch", ana);
    const chatting = await key(ana, launch, presets.chat.scope);
    const reading = await key(ana, launch, presets.read.scope);
    assertEquals(await role(launch, chatting.id), "editor");
    assertEquals(await role(launch, reading.id), "viewer");
    assertEquals(chatting.actor.scope, presets.chat.scope);
  });
});

test("a key reaches what both its membership and its person reach", async () => {
  await setup(async ({ runtime, key, join, role }) => {
    const team = await space(runtime, "Team", bob);
    await join(team, ana, "editor", bob);
    const { id, actor } = await key(ana, team, { call: ["note.write"], query: ["note.texts"] });
    assertEquals(
      await code(runtime.call("note.write", { text: "one", in: team }, { actor })),
      "done",
    );
    // Her role drops: the key's membership still says editor, yet it writes no more.
    await runtime.call("member.set", {
      space: team,
      member: { kind: "person", id: "ana" },
      role: "viewer",
    }, {
      actor: bob,
    });
    assertEquals(await role(team, id), "editor");
    assertEquals(
      await code(runtime.call("note.write", { text: "two", in: team }, { actor })),
      "forbidden",
    );
    assertEquals(await runtime.query("note.texts", {}, { actor }), ["one"]);
    // A viewer makes keys that only read there.
    await assertRejects(
      () => key(ana, team, presets.chat.scope),
      Error,
      "can only read here too",
    );
    const reader = await key(ana, team, presets.read.scope);
    assertEquals(await role(team, reader.id), "viewer");
    // Its person's other spaces are never its.
    const mine = await space(runtime, "Mine", ana);
    await runtime.call("note.write", { text: "diary", in: mine }, { actor: ana });
    assertEquals(await runtime.query("note.texts", {}, { actor }), ["one"]);
    assertEquals(
      await code(runtime.call("note.write", { text: "x", in: mine }, { actor })),
      "forbidden",
    );
  });
});

test("an admin's key reaches only its space, at its role: a key has no org role", async () => {
  await setup(async ({ runtime, key }) => {
    await runtime.call("org.join", { person: "ana", role: "admin" });
    const secret = await space(runtime, "Secret", bob);
    const launch = await space(runtime, "Launch", ana);
    await runtime.call("note.write", { text: "bob's plan", in: secret }, { actor: bob });
    await runtime.call("note.write", { text: "launch", in: launch }, { actor: ana });
    // She reaches everything in the org.
    assertEquals(await runtime.query("note.texts", {}, { actor: ana }), ["bob's plan", "launch"]);
    const { actor } = await key(ana, launch, {
      call: ["note.write", "org.me"],
      query: ["note.texts", "space.reached"],
    });
    assertEquals(await runtime.query("note.texts", {}, { actor }), ["launch"]);
    const reached = await runtime.query<{ _id: string }[]>("space.reached", {}, { actor });
    assertEquals(reached.map((s) => s._id), [launch]);
    assertEquals((await runtime.call<{ role: string | null }>("org.me", {}, { actor })).role, null);
    assertEquals(
      await code(runtime.call("note.write", { text: "x", in: secret }, { actor })),
      "forbidden",
    );
    // A key she makes in a space only her role reaches reaches that space alone.
    const theirs = await key(ana, secret, { query: ["note.texts"] });
    assertEquals(await runtime.query("note.texts", {}, { actor: theirs.actor }), ["bob's plan"]);
  });
});

test("keys show among the space's members; its managers revoke them, others only their own", async () => {
  await setup(async ({ runtime, key, join, role }) => {
    const team = await space(runtime, "Team", bob);
    await join(team, ana, "editor", bob);
    await join(team, cy, "viewer", bob);
    const first = await key(ana, team, presets.chat.scope, "Support bot");
    const second = await key(ana, team, presets.read.scope, "Reporting");
    // Everyone in the space reads its keys; a key reads none, its own neither.
    assertEquals((await shown(runtime, "test.keys", { in: team }, cy) as string[]).sort(), [
      "Reporting",
      "Support bot",
    ]);
    const asKey = { ...first.actor, scope: { view: ["test.keys"] } };
    assertEquals(await shown(runtime, "test.keys", { in: team }, asKey), []);
    // A key's role follows from its scope: nobody sets it.
    assertEquals(
      await code(runtime.call("member.set", {
        space: team,
        member: { kind: "key", id: first.id },
        role: "manager",
      }, { actor: bob })),
      "invalid",
    );
    // Cy, a viewer, revokes only her own; Bob, a manager, any here.
    assertEquals(
      await code(runtime.call("api_key.revoke", { key: first.id }, { actor: cy })),
      "forbidden",
    );
    assertEquals(await runtime.call("api_key.revoke", { key: first.id }, { actor: bob }), {
      revoked: 1,
    });
    assertEquals(await runtime.query("api_key.actor", { secret: "x" }), null);
    assertEquals(await role(team, first.id), undefined);
    // Taken out of the members, a key ends too.
    await runtime.call("member.remove", { space: team, member: { kind: "key", id: second.id } }, {
      actor: bob,
    });
    await runtime.idle();
    assertEquals(await shown(runtime, "test.keys", { in: team }, ana), []);
    // Its person leaving the space: theirs there end.
    const third = await key(ana, team, presets.read.scope, "Again");
    await runtime.call("space.leave", { space: team }, { actor: ana });
    await runtime.idle();
    assertEquals(await role(team, third.id), undefined);
    assertEquals(await shown(runtime, "test.keys", { in: team }, bob), []);
  });
});

test("revoking a key ends its connections at once; its person's stay", async () => {
  await setup(async ({ runtime, as, key, join }) => {
    const team = await space(runtime, "Team", bob);
    await join(team, ana, "editor", bob);
    const first = await key(ana, team, { call: ["note.write"] });
    const second = await key(ana, team, { call: ["note.write"] });
    const script = as(first.actor);
    const other = as(second.actor);
    const hers = as(ana);
    await Promise.all([script.ready, other.ready, hers.ready]);
    assertEquals(await script.call("note.write", { text: "hi", in: team }), { ok: true });
    // A key's calls over the socket are what its scope lists.
    assertEquals(await code(script.call("chat.send", { text: "x", in: team })), "forbidden");
    assertEquals(runtime.stats().browsers, 3);
    await runtime.call("api_key.revoke", { key: first.id }, { actor: ana });
    // Its connection closed with the call (and no ticket brings it back).
    assertEquals(runtime.stats().browsers, 2);
    assertEquals(await other.call("note.write", { text: "still", in: team }), { ok: true });
    assertEquals(await hers.call("note.write", { text: "mine", in: team }), { ok: true });
    // Taken out by a manager, the same.
    await runtime.call("member.remove", { space: team, member: { kind: "key", id: second.id } }, {
      actor: bob,
    });
    await runtime.idle();
    assertEquals(runtime.stats().browsers, 1);
    assertEquals(await hers.call("note.write", { text: "again", in: team }), { ok: true });
  });
});

test("the api plugin's who: a request's bearer key is the key's person, with its scope", async () => {
  await setup(async ({ runtime, bearing, key, join }) => {
    const team = await space(runtime, "Team", bob);
    await join(team, ana, "editor", bob);
    const made = await key(ana, team, { call: ["note.write"] });
    // `/connect` with the key: a ticket for its person, as the key.
    const answered = await runtime.fetch(bearer("/connect", made.secret));
    assertEquals(answered.status, 200);
    assertEquals((await answered.json()).actor, { kind: "person", id: "ana" });
    // Its socket is the key's: what its scope lists, in its space, and nothing more.
    const script = bearing(made.secret);
    await script.ready;
    assertEquals(await script.call("note.write", { text: "hi", in: team }), { ok: true });
    assertEquals(await code(script.call("chat.send", { text: "x", in: team })), "forbidden");
    // A secret that proves nothing is nobody; revoked, the key's secret too.
    assertEquals((await runtime.fetch(bearer("/connect", "not-a-key"))).status, 401);
    await runtime.call("api_key.revoke", { key: made.id }, { actor: ana });
    assertEquals((await runtime.fetch(bearer("/connect", made.secret))).status, 401);
  });
});
