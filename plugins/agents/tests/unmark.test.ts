/**
 * The old marks come off (`chat.unmark`): each marked message goes where
 * only those who could read it see it. In someone's Personal space its
 * marks become its record (`drew`); in a contact's chat it goes into the
 * chat's notes, which the contact never sees; in a shared space, to the
 * Personal space of the person it was for, with a line where it was; with
 * nobody to hold it for, out of every space. It runs by itself on the first
 * start with it (a deploy), logs what it did by kind, and running it again
 * changes nothing; a dry run, through the runtime or straight off a store,
 * says what it would do and writes nothing.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  type Store,
  TIMERS,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message, type Thread } from "../mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { storeReads, unmark, type UnmarkLog } from "../chat/shared/unmark.ts";
import { join } from "../../access/tests/join.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const carla: Actor = { kind: "contact", id: "c-carla-01" };
const maintainer: Actor = { kind: "maintenance", id: "maintenance" };

const echo: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "noted" };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    agents: { lead: { instructions: "Help.", model: "e/lead", default: true } },
  },
  adapters: { llm: { e: echo } },
});

/** What the old labels left, written as they wrote it: by trusted code, marks and all. */
const seed = definePlugin({
  name: "seed",
  actions: {
    "test.seed": defineAction({
      input: { type: "object" },
      run: (
        ctx,
        input: { messages: Record<string, unknown>[]; files: Record<string, unknown>[] },
      ) =>
        ctx.as().transaction(async (tx) => {
          if (input.files.length) await tx.db.collection("file").insertMany(input.files);
          await tx.db.collection("message").insertMany(input.messages);
        }),
    }),
  },
});

/** The first runtime holds the migration back, as a release before it would have. */
const before = definePlugin({ name: "before", schedules: { "chat.unmark": null } });

const plugins = [models, chat, ...access, seed, app];

const T = Date.parse("2026-11-01T12:00:00.000Z");
const at = (n: number) => new Date(T + n * 60_000).toISOString();

type Fixture = {
  store: Store;
  personal: string;
  finance: string;
  launch: string;
  shop: string;
  mine: string;
  team: string;
  carlas: string;
};

/** Spaces, chats and a contact as people made them, then messages the old marks were on. */
async function fixture(): Promise<Fixture> {
  const store = memoryStore();
  const runtime = await createRuntime({ store, plugins: [...plugins, before] });
  try {
    const call = <T>(action: string, input: unknown, actor?: Actor) =>
      runtime.call<T>(action, input, actor ? { actor } : {});
    const { space: personal } = await call<{ space: string }>("space.personal", {}, ana);
    const made = async (name: string, people: string[]) => {
      const { space } = await call<{ space: string }>("space.create", { name }, ana);
      for (const id of people) await join(runtime, space, { kind: "person", id }, "editor", ana);
      return space;
    };
    const finance = await made("Finance", []);
    const launch = await made("Launch", ["bob", "cleo"]);
    const shop = await made("Shop", ["bob"]);
    const { thread: mine } = await call<{ thread: string }>(
      "chat.send",
      { in: personal, text: "margins?" },
      ana,
    );
    const { thread: team } = await call<{ thread: string }>(
      "chat.send",
      { in: launch, text: "plan", title: "Plan" },
      ana,
    );
    await call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await call("chat.send", { thread: carlas, text: "where's my order?" }, carla);
    await runtime.idle();
    const said = (id: string, thread: string, n: number, more: Record<string, unknown>) => ({
      _id: id,
      thread,
      from: "lead",
      to: ["ana"],
      text: `said ${id}`,
      at: at(n),
      ...more,
    });
    await call("test.seed", {
      files: [{
        _id: "f-c3",
        thread: carlas,
        in: shop,
        name: "invoice.txt",
        type: "text/plain",
        size: 4,
        data: btoa("12% "),
        at: at(5),
      }],
      messages: [
        // In Ana's Personal space: marks kept for the day it moved.
        said("p1", mine, 1, { in: personal, sources: [finance] }),
        said("p2", mine, 2, { in: personal, drew: [launch], sources: [finance, personal] }),
        // In Carla's chat: what the line's people saw, and Carla never did.
        said("run1:reply", carlas, 3, {
          in: shop,
          to: [`contact:${carla.id}`],
          turn: "run1",
          sources: [shop],
        }),
        said("run1:step", carlas, 2.5, {
          in: shop,
          to: [],
          turn: "run1",
          private: true,
          toolCalls: [{ id: "x", name: "peek", input: {} }],
          sources: [shop],
        }),
        said("c3", carlas, 5, {
          in: shop,
          to: [`contact:${carla.id}`],
          files: [{ id: "f-c3", name: "invoice.txt", type: "text/plain", size: 4 }],
          sources: [shop],
        }),
        // In Launch: Ana's answer, and Cleo's (a step of its turn too); one for no one.
        said("h1", team, 6, { in: launch, sources: [finance] }),
        said("run2:step", team, 7, {
          in: launch,
          to: [],
          turn: "run2",
          private: true,
          sources: [finance],
        }),
        said("run2:reply", team, 8, { in: launch, to: ["cleo"], turn: "run2", sources: [finance] }),
        said("u1", team, 9, { in: launch, to: ["ops"], sources: [finance] }),
        // Already as it should be: a record, no marks.
        said("m1", team, 10, { in: launch, drew: [finance] }),
      ],
    });
    return { store, personal, finance, launch, shop, mine, team, carlas };
  } finally {
    await runtime.close();
  }
}

/** Every document of what the migration may touch, as the store has it. */
const snapshot = async (store: Store) =>
  Object.fromEntries(
    await Promise.all(
      ["message", "thread", "file", "space", "member"].map(async (c) =>
        [c, await store.find(c, {}, { sort: { _id: 1 } })] as const
      ),
    ),
  );

/** What `actor` reads of a collection, as a page would. */
const reads = async <T>(runtime: Runtime, collection: string, actor: Actor, filter = {}) => {
  const seen = runtime.observe<T[]>(collection, filter, { actor });
  const output = await seen.ready;
  seen.close();
  return output.status === "ready" ? output.value : [];
};

const view = definePlugin({
  name: "view",
  views: Object.fromEntries(
    ["message", "thread", "file"].map((c) => [
      c,
      (
        filter: Record<string, unknown> | undefined,
        ctx: { db: { collection(n: string): { find(f: unknown): { value?: unknown } } } },
      ) => ctx.db.collection(c).find(filter ?? {}).value ?? [],
    ]),
  ),
});

/** Runs `fn` with the runtime's log lines kept instead of printed. */
async function logging<T>(fn: (lines: UnmarkLog[]) => Promise<T>): Promise<T> {
  const lines: UnmarkLog[] = [];
  const print = console.log;
  console.log = (line: unknown) => {
    const parsed = typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined;
    if (parsed?.migration === "chat.unmark") lines.push(parsed);
    else print(line);
  };
  try {
    return await fn(lines);
  } finally {
    console.log = print;
  }
}

const EXPECTED = { personal: 2, contactChats: 3, held: 3, unresolved: 1, placeholders: 3 };

test("a dry run says what it would do, and writes nothing: through the runtime or off a store", async () => {
  const f = await fixture();
  const threads = [
    `${f.carlas}:notes`,
    `${f.team}:held:ana`,
    `${f.team}:held:cleo`,
    `${f.team}:held`,
  ];
  const kept = await snapshot(f.store);
  const events = (await f.store.events(0)).length;
  // Off the store as it is: no owner, nothing claimed.
  const off = await logging(async (lines) => {
    const done = await unmark(storeReads(f.store), { dryRun: true });
    assertEquals(lines.map((l) => [l.dryRun, l.personal, l.contactChats, l.held, l.unresolved]), [
      [true, 2, 3, 3, 1],
    ]);
    return done;
  });
  assertEquals(off.counts, EXPECTED);
  assertEquals(off.threads.sort(), threads.sort());
  assertEquals(off.spaces, ["personal:cleo"]);
  assertEquals(
    off.messages!.map((m) => [m._id, m.kind, m.to ?? "here"]),
    [
      ["c3", "contactChats", `${f.carlas}:notes`],
      ["h1", "held", `${f.team}:held:ana`],
      ["p1", "personal", "here"],
      ["p2", "personal", "here"],
      ["run1:reply", "contactChats", `${f.carlas}:notes`],
      ["run1:step", "contactChats", `${f.carlas}:notes`],
      ["run2:reply", "held", `${f.team}:held:cleo`],
      ["run2:step", "held", `${f.team}:held:cleo`],
      ["u1", "unresolved", `${f.team}:held`],
    ],
  );
  assertEquals(off.placeholders, ["h1:held", "run2:reply:held", "u1:held"]);
  assertEquals(await snapshot(f.store), kept);
  assertEquals((await f.store.events(0)).length, events);
  // Through the runtime, by an operator: the same, and still nothing changes.
  const runtime = await createRuntime({ store: f.store, plugins: [...plugins, before] });
  try {
    const dry = await logging(() =>
      runtime.call<typeof off>("chat.unmark", { dryRun: true }, { actor: maintainer })
    );
    assertEquals(dry.counts, EXPECTED);
    assertEquals(dry.messages, off.messages);
    assertEquals(await snapshot(f.store), kept);
  } finally {
    await runtime.close();
  }
});

test("on the first start with it, each marked message goes where only its readers see it", async () => {
  const f = await fixture();
  const { runtime, lines } = await logging(async (lines) => {
    const runtime = await createRuntime({ store: f.store, plugins: [...plugins, view] });
    await runtime.idle();
    return { runtime, lines };
  });
  try {
    assertEquals(lines.length, 1);
    const { severity, migration, dryRun, personal, contactChats, held, unresolved, placeholders } =
      lines[0];
    assertEquals(
      { severity, migration, dryRun, personal, contactChats, held, unresolved, placeholders },
      { severity: "NOTICE", migration: "chat.unmark", dryRun: false, ...EXPECTED },
    );
    const doc = async (id: string) =>
      (await f.store.findOne("message", { _id: id })) as (Message & { sources?: string[] }) | null;
    // Nothing keeps marks.
    assertEquals(await f.store.find("message", { sources: { $exists: true } }), []);
    // Personal: in place, its marks its record.
    assertEquals([(await doc("p1"))?.thread, (await doc("p1"))?.drew], [f.mine, [f.finance]]);
    // Every id, its own space's too: only Ana reads it.
    assertEquals((await doc("p2"))?.drew, [f.finance, f.launch, f.personal].sort());

    // Carla's chat: into its notes, as it was, at its time; its file too.
    const notes = `${f.carlas}:notes`;
    const made = (await f.store.findOne("thread", { _id: notes })) as Thread | null;
    assertEquals(
      [made?.about, made?.in, made?.title, made?.messages],
      [f.carlas, f.shop, "Staff notes: Carla", 2],
    );
    for (const id of ["run1:reply", "run1:step", "c3"]) {
      assertEquals((await doc(id))?.thread, notes);
    }
    assertEquals((await doc("run1:reply"))?.at, at(3));
    assertEquals((await f.store.findOne("file", { _id: "f-c3" }))?.thread, notes);
    const carlaReads = await reads<Message>(runtime, "message", carla, { thread: f.carlas });
    // What she reads there: what she said, and what the agent answered her, as ever.
    assertEquals(carlaReads.map((m) => m.text), ["where's my order?", "noted"]);
    assertEquals(await reads(runtime, "thread", carla, { _id: notes }), []);
    assertEquals(await reads(runtime, "file", carla, { _id: "f-c3" }), []);
    // The line's people read them, in the notes.
    assertEquals(
      (await reads<Message>(runtime, "message", bob, { thread: notes })).map((m) => m._id).sort(),
      ["c3", "run1:reply", "run1:step"],
    );
    // Its chat counts what's left in it.
    assertEquals(
      ((await f.store.findOne("thread", { _id: f.carlas })) as Thread | null)?.messages,
      2,
    );

    // Launch: Ana's answer to her Personal space, and a line where it was.
    const forAna = `${f.team}:held:ana`;
    const heldForAna = (await f.store.findOne("thread", { _id: forAna })) as Thread | null;
    assertEquals([heldForAna?.in, heldForAna?.title], [f.personal, "Held from Plan"]);
    assertEquals([(await doc("h1"))?.thread, (await doc("h1"))?.in], [forAna, f.personal]);
    const line = await doc("h1:held");
    assertEquals(
      [line?.thread, line?.in, line?.from, line?.at, line?.text],
      [
        f.team,
        f.launch,
        "lead",
        at(6),
        "A reply only ana could see was moved to their Personal space.",
      ],
    );
    // Cleo's, and its turn's step, to the Personal space made for her.
    const forCleo = `${f.team}:held:cleo`;
    assertEquals(
      ((await f.store.findOne("space", { _id: "personal:cleo" })) as { owner?: string } | null)
        ?.owner,
      "cleo",
    );
    assertEquals((await doc("run2:step"))?.thread, forCleo);
    assertEquals((await doc("run2:reply"))?.in, "personal:cleo");
    assertEquals(await doc("run2:step:held"), null);
    // No one's: out of every space, which nobody reads; a line where it was.
    const nobodys = (await f.store.findOne("thread", { _id: `${f.team}:held` })) as Thread | null;
    assertEquals([nobodys?.in, (await doc("u1"))?.in, (await doc("u1"))?.thread], [
      undefined,
      undefined,
      `${f.team}:held`,
    ]);
    assertEquals((await doc("u1:held"))?.text, "A reply only some here could see was held back.");
    // Bob, in Launch: the lines, never what moved; Ana: hers, in her Personal space.
    const bobReads = (await reads<Message>(runtime, "message", bob, { thread: f.team }))
      .map((m) => m._id).sort();
    assert(bobReads.includes("h1:held") && bobReads.includes("u1:held") && bobReads.includes("m1"));
    assert(!bobReads.some((id) => ["h1", "u1", "run2:reply", "run2:step"].includes(id)));
    assertEquals((await reads<Message>(runtime, "message", ana, { _id: "h1" })).length, 1);
    assertEquals((await reads<Message>(runtime, "message", ana, { _id: "u1" })).length, 0);
    // Already migrated: as it was.
    assertEquals([(await doc("m1"))?.thread, (await doc("m1"))?.drew], [f.team, [f.finance]]);
    // The schedule ran once, and says so.
    const timer = await f.store.findOne(TIMERS, { _id: "chat.unmark" });
    assertEquals([timer?.once, timer?.at, timer?.running], [true, undefined, undefined]);
  } finally {
    await runtime.close();
  }
});

test("running it again changes nothing, by hand or on the next start", async () => {
  const f = await fixture();
  const first = await logging(async () => {
    const runtime = await createRuntime({ store: f.store, plugins });
    await runtime.idle();
    return runtime;
  });
  const kept = await snapshot(f.store);
  try {
    const again = await logging(() =>
      first.call<{ counts: Record<string, number> }>("chat.unmark", {}, { actor: maintainer })
    );
    assertEquals(again.counts, {
      personal: 0,
      contactChats: 0,
      held: 0,
      unresolved: 0,
      placeholders: 0,
    });
    assertEquals(await snapshot(f.store), kept);
  } finally {
    await first.close();
  }
  await logging(async (lines) => {
    const next = await createRuntime({ store: f.store, plugins });
    await next.idle();
    await next.close();
    assertEquals(lines, []);
  });
  assertEquals(await snapshot(f.store), kept);
});
