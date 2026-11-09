/**
 * A plugin's declaration: everything it declares, as JSON, read from the
 * plugin and never run (its `allow`s are asked about made-up callers, its
 * startup check runs on its own configuration). A tiny plugin shows each
 * part; Copilotz's own plugins show it holds for real ones (and each product
 * package's tests, for its own).
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  defineAction,
  defineCollection,
  definePlugin,
  inPerson,
  people,
  peopleOrContacts,
  type Plugin,
} from "../mod.ts";
import {
  describe,
  helperOf,
  listing,
  methodsOf,
  minimalOf,
  placeOf,
  probe,
  underName,
} from "../describe.ts";
import { chat } from "../../plugins/agents/mod.ts";
import { googleSignIn, identity } from "../../plugins/access/mod.ts";
import { api, maintenance, mcp } from "../../plugins/interfaces/mod.ts";
import { test } from "../../testing/mod.ts";

let ran = 0;
const run = () => {
  ran++;
  throw new Error("describe ran an Action");
};

/** A plugin with one of everything. */
const notes: Plugin = definePlugin({
  name: "notes",
  requires: ["spaces"],
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        description: "A note in a space.",
        properties: {
          in: { type: "string" },
          text: { type: "string" },
          secret: { type: "string" },
        },
        required: ["in", "text"],
      },
      private: ["secret"],
      vectors: ["embedding"],
      indexes: [["in"]],
      queries: {
        mine: { allow: people, run: () => [] },
        all: () => [],
      },
    }),
    noteLog: defineCollection({
      schema: { type: "object", properties: { note: { type: "string" } } },
      records: true,
    }),
    typing: defineCollection({
      schema: { type: "object", properties: { who: { type: "string" } } },
      durable: false,
    }),
    loose: defineCollection({ schema: { type: "object" } }),
  },
  actions: {
    "note.add": defineAction({
      description: "Adds a note to a space. Its text is Markdown.",
      input: {
        type: "object",
        properties: { in: { type: "string" }, text: { type: "string", minLength: 3 } },
        required: ["in", "text"],
      },
      allow: people,
      run,
    }),
    "note.forget": { description: "Forgets your notes.", allow: inPerson, run },
    "note.reply": { description: "Replies.", allow: peopleOrContacts, run },
    "note.open": { allow: () => true, run },
    "note.own": {
      description: "Changes your own note.",
      input: {
        type: "object",
        properties: { person: { type: "string" } },
        required: ["person"],
      },
      allow: (actor, input) =>
        actor.kind === "person" && actor.id === (input as { person: string }).person,
      run,
    },
    "note.picky": {
      description: "Throws for anyone but a contact.",
      allow: (actor) => {
        if (actor.kind !== "contact") throw new Error("no");
        return true;
      },
      run,
    },
    "note.sweep": { description: "Sweeps old notes.", record: false, run },
  },
  events: {
    "note.flagged": {
      description: "Someone flagged a note.",
      schema: { type: "object", properties: { note: { type: "string" } } },
      allow: people,
    },
  },
  processors: {
    "notes.index": { on: "note.created", key: (event) => String(event.data._id), run },
    "notes.flag": { on: ["note.flagged", "note.updated"], where: { "data.loud": true }, run },
  },
  schedules: { "notes.sweep": { every: "1h", call: "note.sweep", input: {} } },
  views: {
    "web.note": () => null,
    "terminal.note": () => null,
    "llm.note": () => null,
    "context:notes": () => null,
    note: () => null,
    gone: null,
  },
  resources: {
    shared: { note: {}, noteLog: { part: "note" } },
    tools: {
      add_note: {
        description: "Add a note here.",
        input: { type: "object", properties: { text: { type: "string" } } },
        run: (_input: unknown, ctx: { call(name: string): unknown }) => ctx.call("note.add"),
      },
    },
    notes: { style: "short" },
  },
  adapters: { search: { notes: { find: run } } },
  routes: {
    "/notes/:id": (request) => {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null);
      return new Response("ok");
    },
    "/n/*": () => new Response("ok"),
    "https://*.notes.example.com/*": () => new Response("ok"),
  },
  who: () => null,
  guard: () => undefined,
  workers: { scribe: { admit: "note.sweep", workloads: ["scribe.write"] } },
  check(merged) {
    const settings = merged.resources.notes as { key?: string } | undefined;
    if (!settings?.key) throw new Error("set the notes resource's key");
  },
});

test("describe: a plugin's data, by part, without running it", async () => {
  ran = 0;
  const d = await describe(notes, { layer: "standard", runtime: "^1.0.0" });
  assertEquals(ran, 0);
  assertEquals([d.format, d.name, d.requires, d.layer, d.runtime], [
    1,
    "notes",
    ["spaces"],
    "standard",
    "^1.0.0",
  ]);

  // What it keeps.
  assertEquals(d.keeps.map((c) => [c.name, c.kind, c.recorded, c.shared]), [
    ["loose", "documents", true, false],
    ["note", "documents", true, true],
    ["noteLog", "records", false, true],
    ["typing", "live", false, false],
  ]);
  const note = d.keeps.find((c) => c.name === "note")!;
  assertEquals(note.summary, "A note in a space.");
  assertEquals(note.fields, ["in", "text", "secret"]);
  assertEquals([note.private, note.vectors, note.indexes], [["secret"], ["embedding"], [["in"]]]);
  assertEquals(note.queries.map((q) => [q.name, q.internal ?? q.helper]), [
    ["all", true],
    ["mine", "people"],
  ]);
  assertEquals(d.shared, [
    { collection: "note", options: {} },
    { collection: "noteLog", options: { part: "note" } },
  ]);
  assertEquals(d.changes, [
    "loose.created",
    "loose.updated",
    "loose.deleted",
    "note.created",
    "note.updated",
    "note.deleted",
  ]);

  // Who may call what.
  const action = (name: string) => d.actions.find((a) => a.name === name)!;
  assertEquals(action("note.add").summary, "Adds a note to a space. Its text is Markdown.");
  assertEquals(action("note.add").helper, "people");
  assertEquals(action("note.add").tool, "add_note");
  // `people`: a person, an agent working for one, a key, a routine; never a contact.
  assertEquals(action("note.add").callers, {
    person: "yes",
    agent: "yes",
    contact: "no",
    anonymous: "no",
    key: "yes",
    routine: "yes",
    maintenance: "no",
  });
  // `inPerson`: the person themselves, never an agent, a key or work done for them.
  const forget = action("note.forget");
  assertEquals(forget.helper, "inPerson");
  assertEquals(forget.callers, {
    person: "yes",
    agent: "no",
    contact: "no",
    anonymous: "no",
    key: "no",
    routine: "no",
    maintenance: "no",
  });
  const reply = action("note.reply");
  assertEquals([reply.helper, reply.callers!.contact, reply.callers!.agent], [
    "peopleOrContacts",
    "yes",
    "yes",
  ]);
  assertEquals([action("note.open").helper, action("note.open").callers!.anonymous], [
    "anyone",
    "yes",
  ]);
  // An allow that reads the input, or throws, depends on it.
  const own = action("note.own");
  assertEquals([own.callers!.person, own.callers!.anonymous, own.note], [
    "some",
    "no",
    "depends on input",
  ]);
  const picky = action("note.picky").callers!;
  assertEquals([picky.contact, picky.person, picky.anonymous], ["yes", "some", "some"]);
  assertEquals([action("note.sweep").internal, action("note.sweep").recorded], [true, false]);

  // The rest.
  assertEquals(d.tools, [{
    name: "add_note",
    summary: "Add a note here.",
    input: { type: "object", properties: { text: { type: "string" } } },
  }]);
  assertEquals(d.emits.map((e) => [e.type, e.summary, e.callers?.person, e.callers?.key]), [
    ["note.flagged", "Someone flagged a note.", "yes", "no"],
  ]);
  assertEquals(d.processors, [
    {
      name: "notes.flag",
      on: ["note.flagged", "note.updated"],
      where: { "data.loud": true },
      keyed: false,
    },
    { name: "notes.index", on: ["note.created"], keyed: true },
  ]);
  assertEquals(d.listens, ["note.created", "note.flagged", "note.updated"]);
  assertEquals(d.schedules, [{
    name: "notes.sweep",
    when: "every 1h",
    summary: "Sweeps old notes.",
    call: "note.sweep",
    every: "1h",
  }]);
  assertEquals(d.views.map((v) => [v.name, v.place, v.removes ?? false]), [
    ["context:notes", "prompt", false],
    ["gone", "other", true],
    ["llm.note", "prompt", false],
    ["note", "other", false],
    ["terminal.note", "terminal", false],
    ["web.note", "web", false],
  ]);
  assertEquals(d.routes.map((r) => [r.path, r.method, r.host, r.underName]), [
    ["/n/*", "ANY", false, false],
    ["/notes/:id", "GET, HEAD", false, true],
    ["https://*.notes.example.com/*", "ANY", true, false],
  ]);
  assertEquals(d.powers, ["who", "guard", "workers"]);
  assertEquals(d.adapters, { search: ["notes"] });
  assertEquals(d.workers, [{ kind: "scribe", admit: "note.sweep", workloads: ["scribe.write"] }]);
  assertEquals(Object.keys(d.resources.provides), ["notes", "shared", "tools"]);
  assertEquals(d.resources.provides.tools.add_note, { description: "Add a note here." });

  // What it needs: its check, on its own resources, says.
  assertEquals(d.check, { reads: ["notes"], asks: [], refuses: "set the notes resource's key" });
  assertEquals(d.needs, [{
    kind: "setting",
    path: "notes",
    summary: "set the notes resource's key",
    required: true,
  }]);
  assertEquals(d.resources.reads, [{ kind: "notes", found: ["check"] }]);

  // Data: JSON as it is, the same every time.
  assertEquals(JSON.parse(JSON.stringify(d)), d);
  assertEquals(await describe(notes, { layer: "standard", runtime: "^1.0.0" }), d);
});

test("describe: what the CLI finds in code joins the declaration", async () => {
  const d = await describe(notes, {
    summary: "Notes: what people jot down.",
    reads: ["notes", "agents"],
    settings: [{
      kind: "notes",
      type: "NotesSettings",
      inContract: false,
      fields: [
        {
          name: "key",
          type: "string",
          optional: false,
          doc: "The key notes are signed with.",
          secret: true,
        },
        { name: "style", type: "string", optional: true, secret: false },
      ],
    }],
  });
  assertEquals(d.summary, "Notes: what people jot down.");
  assertEquals(d.resources.reads, [
    { kind: "agents", found: ["source"] },
    { kind: "notes", found: ["check", "source"] },
  ]);
  // Its settings' fields are what it needs; a key is a secret.
  assertEquals(d.needs, [
    {
      kind: "secret",
      path: "notes.key",
      summary: "The key notes are signed with.",
      required: true,
      type: "string",
    },
    { kind: "setting", path: "notes.style", summary: "", required: false, type: "string" },
  ]);
  assert(d.listing.problems.includes(`Setting "notes" (NotesSettings) isn't in its contract.`));
});

test("listing: a schema, routes under its name, settings in its contract; warnings for the open", async () => {
  const d = await describe(notes);
  assertFalse(d.listing.listable);
  assertEquals(d.listing.problems, [
    `Collection "loose" has a schema that names no fields.`,
    `Route "/n/*" isn't under /notes.`,
    `Route "https://*.notes.example.com/*" takes whole hosts, not paths under /notes.`,
  ]);
  assert(d.listing.warnings.includes(`Action "note.open" is open to anyone, signed in or not.`));
  assert(d.listing.warnings.includes(`Action "note.open" has no description.`));
  assert(
    d.listing.warnings.includes(
      `Action "note.picky" is open to anyone (depends on input), signed in or not.`,
    ),
  );

  const tidy = await describe(definePlugin({
    name: "tidy",
    collections: { tidy: { schema: { type: "object", properties: { at: { type: "string" } } } } },
    actions: {
      "tidy.up": { description: "Tidies.", input: { type: "object" }, allow: people, run },
    },
    routes: { "/tidy/*": () => new Response("ok"), "/tidy": () => new Response("ok") },
  }));
  assertEquals(tidy.listing, { listable: true, problems: [], warnings: [] });
  assertEquals(listing({ ...tidy, routes: [] }).listable, true);
});

test("probe, helpers, places, paths and methods", () => {
  // A minimal input from a schema: its required fields.
  assertEquals(
    minimalOf({
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        count: { type: "integer", minimum: 3 },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        kind: { enum: ["a", "b"] },
        on: { type: "boolean" },
        deep: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        optional: { type: "string" },
      },
      required: ["name", "count", "tags", "kind", "on", "deep"],
    }),
    { name: "xx", count: 3, tags: ["x"], kind: "a", on: false, deep: { id: "x" } },
  );
  assertEquals(minimalOf(undefined), undefined);
  assertEquals(minimalOf({ anyOf: [{ type: "null" }, { type: "string" }] }), null);

  assertEquals(probe(() => false), {
    person: "no",
    agent: "no",
    contact: "no",
    anonymous: "no",
    key: "no",
    routine: "no",
    maintenance: "no",
  });
  assertEquals(probe((actor) => actor.kind === "maintenance").maintenance, "yes");
  // Every caller works somewhere (`in`); an agent works for a person, and both must be let in.
  assertEquals(probe((actor) => actor.in === "probe-space").agent, "yes");
  assertEquals(probe((actor) => actor.kind === "agent").agent, "no");

  assertEquals(helperOf(people), "people");
  assertEquals(helperOf(inPerson), "inPerson");
  assertEquals(helperOf(() => true), undefined);
  assertEquals(helperOf((actor: { kind: string }) => actor.kind === "person"), undefined);
  assertEquals(helperOf(undefined), undefined);
  // By name, only when it lets in whom the helper does.
  function isMaintenance(actor: { kind: string }) {
    return actor.kind === "maintenance";
  }
  assertEquals(helperOf(isMaintenance), "isMaintenance");
  const people2 = { people: (actor: { kind: string }) => actor.kind === "person" }.people;
  assertEquals(helperOf(people2), undefined);

  assertEquals(placeOf("web.message"), "web");
  assertEquals(placeOf("terminal.thread"), "terminal");
  assertEquals(["llm.thread", "context:where", "tool:read", "mcp:offered"].map((n) => placeOf(n)), [
    "prompt",
    "prompt",
    "prompt",
    "prompt",
  ]);
  assertEquals(placeOf("board"), "other");
  assertEquals(placeOf("board", "web"), "web");

  assert(underName("/mcp/*", "mcp"));
  assert(underName("/maintenance/:what", "maintenance"));
  assertFalse(underName("/hooks/whatsapp/*", "whatsapp"));
  assertFalse(underName("https://*.example.com/*", "x"));

  assertEquals(methodsOf((r: Request) => r.method === "POST" ? new Response() : new Response()), [
    "POST",
  ]);
  assertEquals(methodsOf(() => new Response()), []);
});

test("describe: Copilotz's chat, mcp, identity, google sign-in, maintenance and api", async () => {
  // Chat: people and contacts send as themselves, never an agent; its own code says; a route
  // outside its name.
  const c = await describe(chat);
  const send = c.actions.find((a) => a.name === "chat.send")!;
  assertEquals(
    [send.callers!.person, send.callers!.contact, send.callers!.agent, send.callers!.anonymous],
    ["yes", "yes", "no", "no"],
  );
  assert(c.actions.find((a) => a.name === "chat.say")!.internal);
  assertEquals(c.schedules.map((s) => [s.name, s.when]), [["chat.prune", "every 1h"]]);
  assert(c.listens.includes("turn.requested"));
  assertEquals(c.emits.map((e) => e.type), ["turn.requested"]);
  assertEquals(c.keeps.find((k) => k.name === "live")!.kind, "live");
  assert(c.listing.problems.includes(`Route "/files/*" isn't under /chat.`));

  // MCP: its routes under its name, its check reads its settings.
  const m = await describe(mcp);
  assertEquals(m.routes.map((r) => [r.path, r.underName]), [["/mcp/*", true]]);
  assert(m.check!.reads.includes("mcp"));
  assert(m.views.some((v) => v.name === "mcp:offered" && v.place === "prompt"));

  // Identity: who a request is, and routes of its own outside its name.
  const i = await describe(identity);
  assertEquals(i.powers, ["who", "guard"]);
  assertEquals(i.routes.map((r) => [r.path, r.method]), [["/me", "GET"], ["/signout", "POST"]]);
  assertFalse(i.listing.listable);

  // Google sign-in: what its check refuses without, a sign-in no actor calls directly.
  const g = await describe(googleSignIn);
  assertEquals(g.check!.refuses, "set the google resource's clientId");
  assert(g.actions.every((a) => a.internal));

  // Maintenance: its Actions are the maintenance key's alone.
  const mt = await describe(maintenance);
  for (const a of mt.actions) {
    assertEquals(a.helper, "isMaintenance");
    assertEquals(a.callers, {
      person: "no",
      agent: "no",
      contact: "no",
      anonymous: "no",
      key: "no",
      routine: "no",
      maintenance: "yes",
    });
  }

  // Developer keys: only a person themselves makes one.
  const k = await describe(api);
  const create = k.actions.find((a) => a.name === "api_key.create")!;
  assertEquals(
    [create.helper, create.callers!.person, create.callers!.key, create.callers!.agent],
    [
      "inPerson",
      "yes",
      "no",
      "no",
    ],
  );
});
