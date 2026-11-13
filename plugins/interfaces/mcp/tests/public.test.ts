/**
 * A public server (`public: true`): anyone's, and keeping nothing. It lists
 * only the tools that only read and that the public is offered, with no
 * handle, in both eras of the protocol; each call runs as the public, reads
 * only what's let to it, and leaves no document and no event; a tool that
 * says it only reads and writes anyway is refused; its calls are limited by
 * address and on the server, in memory that doesn't grow with callers; a
 * call past the timeout is stopped. A server that keeps conversations is as
 * it was beside it.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  people,
  publicCallers,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat, tool } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { mcp } from "../mod.ts";
import { minuteOf, perMinute } from "../resources/limits.ts";
import type { DeclaredServer } from "../shared/settings.ts";
import { app, LINE, runs, said, type Setup, setup } from "./setup.ts";

type Note = { _id: string; in: string; text: string };
const text = { type: "string" } as const;
const opened = (actor: Actor) => people(actor) || publicCallers(actor);
const FAILED = "Something went wrong running that tool. Try again in a moment.";

/** Notes in spaces, and tools over them that only read (or say so). */
const notes = definePlugin({
  name: "notes",
  collections: {
    note: { schema: { type: "object", properties: { in: text, text }, required: ["in", "text"] } },
  },
  actions: {
    // What the caller reaches, read and kept nowhere: what a public tool reads through.
    "note.list": defineAction({
      input: { type: "object" },
      allow: opened,
      record: false,
      run: async (ctx) =>
        (await ctx.db.collection<Note>("note").find({})).map((n) => n.text).sort(),
    }),
  },
  views: {
    ...Object.fromEntries(
      ["notes", "sneak", "who", "dawdle", "inside"].map((name) => [
        `tool:${name}`,
        (call: { output: string }) => call.output,
      ]),
    ),
    // Every document of the collections it's given, as the system.
    "test:documents": (item: { names: string[] }, ctx: ViewContext) =>
      item.names.reduce((n, name) => n + (ctx.db.collection(name).find({}).value?.length ?? 0), 0),
  },
  resources: {
    shared: { note: {} },
    tools: {
      notes: tool({
        description: "Reads the notes its caller reaches",
        annotations: { readOnly: true },
        run: (_input, ctx) => ctx.call("note.list", {}),
      }),
      sneak: tool({
        description: "Says it only reads, and writes",
        annotations: { readOnly: true },
        run: async (_input, ctx) => {
          await ctx.db.collection("note").insertOne({ in: ctx.in!, text: "sneaked" });
          return "Wrote.";
        },
      }),
      who: tool({
        description: "Says who runs it, and where",
        annotations: { readOnly: true },
        run: (_input, ctx) =>
          JSON.stringify({
            kind: ctx.actor?.kind,
            id: ctx.actor?.id,
            mcp: ctx.actor?.mcp,
            in: ctx.in,
            agent: ctx.agent,
            thread: ctx.thread,
            callId: ctx.callId,
            retry: ctx.retry,
          }),
      }),
      // Offered to anyone but the public.
      inside: tool({
        description: "The team's own",
        annotations: { readOnly: true },
        offer: (_agent, _thread, ctx) => ctx.actor?.kind !== "public",
        run: () => "INSIDE",
      }),
      // Takes two seconds, unless its signal says stop.
      dawdle: tool({
        description: "Takes its time",
        annotations: { readOnly: true },
        run: (_input, ctx) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve("Done, late."), 2_000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve("Stopped.");
            });
          }),
      }),
    },
  },
});

/** A public server over the app's tools: some only read, some don't, one not offered to it. */
const PUBLIC: Partial<DeclaredServer> = {
  public: true,
  tools: {
    search: {},
    pick: {},
    status: {},
    notes: {},
    who: {},
    sneak: {},
    inside: {},
    dawdle: {},
    // Read-only as this server says, over the tool's own hints.
    peek: { annotations: { readOnly: true } },
  },
};

/** What the public server lists: the tools that only read, but `inside`, in order. */
const LISTED = ["search", "status", "notes", "who", "sneak", "dawdle", "peek"];

/** Every document in the app's collections, and every event, once the runtime's idle. */
async function kept(s: Setup) {
  await s.runtime.idle();
  const names = Object.keys(s.runtime.describe().collections);
  const seen = s.runtime.observe<number>("test:documents", { names });
  const counted = await seen.ready;
  seen.close();
  if (counted.status !== "ready") throw new Error(`Not counted: ${counted.status}`);
  return { documents: counted.value, events: (await store.events(0, 10_000_000)).length };
}

/** The store of the test running (one at a time). */
let store = memoryStore();

/** Notes in `line` (the server's space) and in `review`; the public let into `line`, unless not. */
async function seeded(s: Setup, open = true) {
  await s.runtime.call("space.keep", { id: "line" });
  await s.runtime.call("space.keep", { id: "review" });
  await s.runtime.call("test.note", { in: "line", text: "open" });
  await s.runtime.call("test.note", { in: "review", text: "internal" });
  if (open) {
    await s.runtime.call("member.set", {
      space: "line",
      member: { kind: "public", id: "" },
      role: "viewer",
    });
  }
}

/** The test's hands: a note written as the system. */
const hands = definePlugin({
  name: "public-hands",
  actions: {
    "test.note": {
      input: { type: "object" },
      run: (ctx, input: { in: string; text: string }) => ctx.db.collection("note").insertOne(input),
    },
  },
});

const publicSetup = (
  fn: (s: Setup) => Promise<void>,
  options: { line?: Partial<DeclaredServer>; lines?: Record<string, DeclaredServer> } = {},
) => {
  store = memoryStore();
  return setup(fn, {
    store,
    plugins: [notes, hands],
    ...(options.lines ? { lines: options.lines } : { line: { ...PUBLIC, ...options.line } }),
  });
};

const names = (rpc: { body: { result?: Record<string, unknown> } }) =>
  (rpc.body.result?.tools as { name: string }[]).map((t) => t.name);

test("a public server lists only the tools that only read, that the public is offered; no handle", async () => {
  await publicSetup(async (s) => {
    // A client with the handshake (2025-11-25), and one without (2026-07-28): the same tools.
    const init = await s.legacy("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assertEquals(init.body.result?.protocolVersion, "2025-11-25");
    assertEquals(init.body.result?.capabilities, { tools: {} });
    const legacy = await s.legacy("tools/list");
    assertEquals(names(legacy), LISTED);
    const modern = await s.modern("tools/list");
    assertEquals([modern.status, names(modern)], [200, LISTED]);
    // No conversation, so no handle: each tool's input is its own.
    const tools = legacy.body.result?.tools as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
      annotations: { readOnlyHint: boolean };
    }[];
    for (const listed of tools) {
      assert(!Object.hasOwn(listed.inputSchema.properties ?? {}, "chat"), listed.name);
      assertEquals(listed.annotations.readOnlyHint, true);
    }
    // What isn't listed isn't called: a tool that writes, one not offered to the public.
    for (const name of ["pick", "inside"]) {
      const refused = await s.call(name, name === "pick" ? { trip: "T1" } : {});
      assertEquals(refused.body.error?.code, -32602);
    }
    assertEquals([runs.pick, runs.search], [undefined, undefined]);
  });
});

test("a call runs as the public and keeps nothing: no contact, chat, step or event", async () => {
  await publicSetup(async (s) => {
    await seeded(s);
    const before = await kept(s);
    const who = JSON.parse(said(await s.call("who")));
    assertEquals([who.kind, who.id, who.mcp, who.in], ["public", "", "chatgpt", "line"]);
    assertEquals([who.agent, who.thread, who.retry], ["ChatGPT", "", false]);
    assertMatch(who.callId, /^mcp-public:[0-9a-f-]{36}$/);
    // What's let to the public, that alone; the tool's View, never its output as it is.
    assertEquals(said(await s.call("notes")), '["open"]');
    assertEquals(said(await s.call("search", { to: "Rio" })), "2 trips: Rio 10:30, Rio 14:00");
    // A conversation named, or a handle sent along, names nothing here: no answer ends with one.
    const named = await s.call("status", {}, { session: "conv-1", subject: "ana" });
    assertEquals(said(named), "Not paid yet.");
    const modern = await s.modern("tools/call", { name: "search", arguments: { to: "Bahia" } });
    assertEquals(said(modern), "2 trips: Bahia 10:30, Bahia 14:00");
    assertEquals(modern.body.result?.resultType, "complete");
    // Nothing kept: not a document, not an event.
    assertEquals(await kept(s), before);
    assertEquals(await s.docs("contact"), []);
    assertEquals(await s.docs("mcp_rate"), []);
  });
});

test("the public reads only spaces that have it as a viewer", async () => {
  await publicSetup(async (s) => {
    await seeded(s, false);
    assertEquals(said(await s.call("notes")), "[]");
  });
});

test("a tool that says it only reads, and writes, is refused: nothing lands", async () => {
  await publicSetup(async (s) => {
    await seeded(s);
    const before = await kept(s);
    const sneaked = await s.call("sneak");
    assertEquals([sneaked.body.result?.isError, said(sneaked)], [true, FAILED]);
    assertEquals(await kept(s), before);
    assertEquals(said(await s.call("notes")), '["open"]');
  });
});

test("limits: calls a minute from an address, then on the server, trip; the next minute, served", async () => {
  await publicSetup(async (s) => {
    const from = (address: string) => ({ headers: { "cf-connecting-ip": address } });
    for (let i = 0; i < 2; i++) assertEquals(said(await s.call("status")), "Not paid yet.");
    const slow = await s.call("status");
    assertEquals([slow.body.result?.isError, said(slow)], [
      true,
      "Too many calls from here: wait a minute, then try again.",
    ]);
    // Another address still is, till the server's 3 a minute.
    assertEquals(said(await s.call("status", {}, from("198.51.100.1"))), "Not paid yet.");
    const full = await s.call("status", {}, from("198.51.100.2"));
    assertEquals(said(full), "This app is busy right now: try again in a few minutes.");
    // Only calls taken count, and ran.
    assertEquals(runs.status, 3);
    // The next minute counts from nothing.
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try {
      assertEquals(said(await s.call("status")), "Not paid yet.");
    } finally {
      Date.now = now;
    }
  }, { line: { limits: { ipPerMinute: 2, linePerMinute: 3 } } });
});

test("limits: the address as the front says it; one claimed around it isn't believed", async () => {
  await publicSetup(async (s) => {
    assertEquals(said(await s.call("status")), "Not paid yet.");
    const again = await s.call("status", {}, { headers: { "x-forwarded-for": "192.0.2.9" } });
    assertEquals(said(again), "Too many calls from here: wait a minute, then try again.");
    // Around the front: refused before anything runs.
    const around = await s.call("status", {}, { headers: { "x-copilotz-front": "" } });
    assertEquals(around.status, 403);
    assertEquals(runs.status, 1);
  }, { line: { limits: { ipPerMinute: 1 } } });
});

test("limits: calls at once on the server; past them, busy, and the places come back", async () => {
  await publicSetup(async (s) => {
    const slow = s.call("dawdle", {}, { headers: { "cf-connecting-ip": "198.51.100.1" } });
    // Let it take its place.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const busy = await s.call("status", {}, { headers: { "cf-connecting-ip": "198.51.100.2" } });
    assertEquals([busy.status, busy.body.error?.code], [503, -31000]);
    assertEquals(said(await slow), "It took too long, so it was stopped: try again in a moment.");
    // Once it's stopped, its place is free.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(said(await s.call("status")), "Not paid yet.");
  }, { line: { limits: { atOnce: 1, timeout: 0.2 } } });
});

test("limits by address keep to a fixed memory, however many addresses call", async () => {
  await publicSetup(async (s) => {
    const minute = minuteOf(s.runtime, "chatgpt");
    const bytes = minute.bytes;
    for (let i = 0; i < 200; i++) {
      const address = `198.51.${100 + (i >> 8)}.${i & 255}`;
      const answer = await s.call("status", {}, { headers: { "cf-connecting-ip": address } });
      assertEquals(said(answer), "Not paid yet.");
    }
    assertEquals(minuteOf(s.runtime, "chatgpt"), minute);
    assertEquals(minute.bytes, bytes);
  });
  // A sketch smaller than the addresses calling: never fewer calls counted than an address made.
  const small = perMinute(64);
  const at = Date.UTC(2026, 10, 12, 12, 0, 10);
  for (let i = 0; i < 100_000; i++) {
    assertEquals(small.take(`4:${i.toString(16)}`, { address: 1e9, all: 1e9 }, at), undefined);
  }
  assertEquals(small.bytes, 2 * 64 * 4);
  // Crowded, an address may be refused sooner than its limit, never later.
  let taken = 0;
  while (!small.take("4:c0000201", { address: 5, all: 1e9 }, at)) taken++;
  assert(taken <= 5, `${taken} taken`);
  // The minute after, every address counts from nothing.
  const next = at + 60_000;
  assertEquals(small.take("4:c0000201", { address: 1, all: 1 }, next), undefined);
  assertEquals(small.take("4:c0000202", { address: 1, all: 1 }, next), "all");
  assertEquals(small.take("4:c0000201", { address: 1, all: 5 }, next), "address");
});

test("a call past the server's timeout is stopped: its signal aborts", async () => {
  await publicSetup(async (s) => {
    const answer = await s.call("dawdle");
    assertEquals([answer.body.result?.isError, said(answer)], [
      true,
      "It took too long, so it was stopped: try again in a moment.",
    ]);
  }, { line: { limits: { timeout: 0.05 } } });
});

test("a server that keeps conversations, beside a public one, keeps them as it did", async () => {
  await publicSetup(async (s) => {
    await seeded(s);
    const before = await kept(s);
    assertEquals(
      said(await s.call("search", { to: "Rio" }, { line: "docs" })),
      "2 trips: Rio 10:30, Rio 14:00",
    );
    assertEquals(await kept(s), before);
    const answer = await s.call("search", { to: "Rio" }, { session: "conv-1" });
    assertEquals(said(answer), "2 trips: Rio 10:30, Rio 14:00");
    assertEquals((await s.docs("contact")).length, 1);
    const tools = await s.legacy("tools/list");
    assert(names(tools).includes("pick"));
  }, {
    lines: {
      chatgpt: LINE,
      docs: { ...LINE, ...PUBLIC } as DeclaredServer,
    },
  });
});

test("at start: a public server's mistakes stop the app", async () => {
  const start = (line: Partial<DeclaredServer>) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        mcp,
        app,
        definePlugin({
          name: "lines",
          resources: { mcp: { docs: { ...LINE, public: true, ...line } } },
        }),
      ],
    }).then((runtime) => runtime.close());
  await assertRejects(() => start({ public: "yes" as never }), Error, "public is true or false");
  await assertRejects(() => start({ handles: true }), Error, "no handles");
  await assertRejects(
    () => start({ tools: { search: {}, status: { widget: "trips.status" } } }),
    Error,
    "no widgets",
  );
  await assertRejects(() => start({ tools: { pick: {}, boom: {} } }), Error, "only reads");
  // One that only reads is enough: the others aren't offered.
  await start({ tools: { search: {}, pick: {} } });
});
