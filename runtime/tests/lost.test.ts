/**
 * A runtime that lost its store to another owner stops serving, at once and
 * loudly. Two owners on one store (memory, SQLite, PostgreSQL): the second
 * opens it, and the first finds out at its next write, or idle, by its fence
 * check. From then on it answers 503 with `retry-after` to everything, a
 * route, a webhook and a socket included; its timers and Processors stop;
 * nothing more goes to its store; and `lost` says so once, with one line
 * logged. A pool keeps a lost runtime answering 503, opening it again only
 * `idleMs` after it was lost.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  manualClock,
  type Runtime,
  runtimes,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");

/** One database, opened as two processes would: each `open` a store of its own on it. */
type Shared = { open(): Promise<Store>; close(): Promise<void> };

/** On PostgreSQL, a schema of the test's own, on a pool both stores share (PGlite has one). */
async function postgres(url: string): Promise<Shared> {
  const pool = await postgresPool({ url, writes: 2, reads: 1 });
  const schema = `l_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    open: () => postgresStore({ pool, schema }),
    close: async () => {
      await pool.writes.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.close();
    },
  };
}

const databases: Record<string, () => Promise<Shared>> = {
  // Memory is one process's: two runtimes on one store stand for two owners.
  memory: () => {
    const store = memoryStore();
    return Promise.resolve({ open: () => Promise.resolve(store), close: () => Promise.resolve() });
  },
  sqlite: () => {
    const path = tempFile(".sqlite");
    return Promise.resolve({ open: () => sqliteStore({ path }), close: () => Promise.resolve() });
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

const START = "2026-11-25T15:00:00Z";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A messaging app's shape: a webhook that records each message, a page, a
 * Processor that hears each one, and a timer every minute. It counts what
 * ran; `gate`, when given, holds each delivery until it's let go.
 */
function inbox(gate?: Promise<void>) {
  const ran = { ticks: 0, seen: 0 };
  const plugin = definePlugin({
    name: "inbox",
    collections: {
      message: defineCollection({
        schema: { type: "object", properties: { text: { type: "string" } } },
        queries: { all: (messages) => messages.find({}) },
      }),
      note: defineCollection({
        schema: { type: "object", properties: { on: { type: "string" } } },
      }),
    },
    actions: {
      "message.add": defineAction({
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: async (ctx, input) =>
          (await ctx.db.collection("message").insertOne({ text: input.text })).insertedId,
      }),
      "tick.add": defineAction({ input: { type: "object" }, run: () => void ran.ticks++ }),
    },
    processors: {
      "message.seen": {
        on: "message.created",
        run: async (ctx, event) => {
          ran.seen++;
          await gate;
          await ctx.db.collection("note").insertOne({ on: event.id });
        },
      },
    },
    events: { "message.ping": { schema: { type: "object" } } },
    schedules: { beat: { every: "1m", call: "tick.add" } },
    routes: {
      // A messaging provider's webhook: whatever it posts is a message.
      "/hooks/in": async (request, { runtime }) =>
        Response.json({ id: await runtime.call("message.add", { text: await request.text() }) }),
      "/page": () => new Response("page"),
    },
  });
  return { plugin, ran };
}

const webhook = (text: string) =>
  new Request("http://localhost/hooks/in", { method: "POST", body: text });
const page = () => new Request("http://localhost/page");
const health = () => new Request("http://localhost/health");
/** A socket's upgrade, as a browser or an executor asks for one. */
const upgrade = () =>
  new Request("http://localhost/oxian", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });

/** Every request it might get, each answered 503 to try again in a few seconds. */
async function refusesEverything(runtime: Runtime) {
  for (const request of [webhook("after"), page(), health(), upgrade()]) {
    const answer = await runtime.fetch(request);
    assertEquals(answer.status, 503, request.url);
    assertEquals(answer.headers.get("retry-after"), "5");
    assertStringIncludes((await answer.json()).error, "lost its store");
  }
}

/** Resolves with `lost`, or fails after `ms`. */
const lostWithin = (runtime: Runtime, ms = 5_000) =>
  Promise.race([
    runtime.lost,
    sleep(ms).then(() => {
      throw new Error("Not lost in time");
    }),
  ]);

/** The lines logged meanwhile, as `console.error` was told them. */
async function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await run(), lines };
  } finally {
    console.error = error;
  }
}

/** A store that counts the commits it was asked for. */
function counting(store: Store): Store & { commits: () => number } {
  let commits = 0;
  return {
    ...store,
    transaction: (epoch, work, options) => (commits++, store.transaction(epoch, work, options)),
    ...(store.command
      ? {
        command: (epoch: number, command: Parameters<NonNullable<Store["command"]>>[1]) => (
          commits++, store.command!(epoch, command)
        ),
      }
      : {}),
    commits: () => commits,
  };
}

each(
  "its next write finds it lost; then every request gets 503, webhooks and sockets too",
  async (db) => {
    const { plugin } = inbox();
    const first = await createRuntime({
      store: await db.open(),
      plugins: [plugin],
      warn: false,
      fenceCheck: false,
    });
    const took = await first.fetch(webhook("before"));
    assertEquals(took.status, 200);
    await took.body?.cancel();
    let second: Runtime | undefined;
    try {
      const { result: lost, lines } = await logged(async () => {
        // Another process opens the store: a second instance, a newer deploy.
        second = await createRuntime({
          store: await db.open(),
          plugins: [plugin],
          warn: false,
          fenceCheck: false,
        });
        // The next webhook's write finds out: it's told to send again, not that it was taken.
        const late = await first.fetch(webhook("late"));
        assertEquals([late.status, late.headers.get("retry-after")], [503, "5"]);
        assertStringIncludes((await late.json()).error, "lost its store");
        return await lostWithin(first);
      });
      assertEquals(lost.epoch, 1);
      assertStringIncludes(lost.message, "another owner holds the store");
      assertStringIncludes(lost.message, "at epoch 2");
      assertStringIncludes(lost.message, "It held epoch 1, and stopped serving");
      assertEquals(lines, [`copilotz: ${lost.message}`]);
      await refusesEverything(first);
      // Callers in the process are refused as plainly.
      await assertRejects(() => first.call("message.add", { text: "x" }), Error, "fenced");
      await assertRejects(() => first.query("message.all"), Error, "fenced");
      await assertRejects(() => first.emit("message.ping"), Error, "fenced");
      // What it took before is the store's; nothing after.
      const texts = (await second!.query<{ text: string }[]>("message.all")).map((m) => m.text);
      assertEquals(texts, ["before"]);
      // The other owner goes on serving.
      const answered = await second!.fetch(webhook("to the owner"));
      assertEquals(answered.status, 200);
      await answered.body?.cancel();
    } finally {
      // Closing a lost runtime waits for the stop it began; nothing to save, nothing failing.
      await first.close();
      await second?.close();
    }
  },
);

each("an idle owner finds out by its fence check; its timers and Processors stop", async (db) => {
  let release!: () => void;
  const { plugin, ran } = inbox(new Promise((resolve) => release = resolve));
  const clock = manualClock(START);
  const first = await createRuntime({
    store: await db.open(),
    plugins: [plugin],
    clock,
    warn: false,
    fenceCheck: 5_000,
  });
  // Its timer, once; then a message whose delivery is still running when the store goes.
  clock.advance(60_000);
  await first.idle();
  assertEquals(ran.ticks, 1);
  // Processors' positions are saved a moment after they move: before the store goes.
  await sleep(300);
  await first.call("message.add", { text: "held" });
  while (ran.seen < 1) await sleep(5);
  let second: Runtime | undefined;
  try {
    // Nothing writes: only the check, every 5 s on its clock, can find out.
    const { lines } = await logged(async () => {
      second = await createRuntime({
        store: await db.open(),
        plugins: [inbox().plugin],
        clock: manualClock(START),
        warn: false,
        fenceCheck: false,
      });
      let lost = false;
      void first.lost.then(() => lost = true);
      for (let i = 0; i < 20 && !lost; i++) {
        clock.advance(5_000);
        await sleep(25);
      }
      assert(lost, "the check found it lost");
    });
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "another owner holds the store");
    await refusesEverything(first);
    // The delivery it was running ends (its write refused) and isn't tried again here.
    release();
    await sleep(700);
    assertEquals(ran.seen, 1);
    // Its timer fires no more, however long goes by.
    const ticks = ran.ticks;
    clock.advance(10 * 60_000);
    await sleep(50);
    assertEquals(ran.ticks, ticks);
    assertEquals(first.stats().pending, 0);
  } finally {
    await first.close();
    await second?.close();
  }
});

test("a lost runtime says so once, however many writes find out, and sends its store nothing more", async () => {
  const shared = memoryStore();
  const store = counting(shared);
  const clock = manualClock(START);
  const { plugin } = inbox();
  const first = await createRuntime({
    store,
    plugins: [plugin],
    clock,
    warn: false,
    fenceCheck: 1_000,
  });
  const second = await createRuntime({
    store: shared,
    plugins: [plugin],
    warn: false,
    fenceCheck: false,
  });
  try {
    let told = 0;
    void first.lost.then(() => told++);
    const { lines } = await logged(async () => {
      const writes = Array.from(
        { length: 5 },
        (_, i) =>
          first.call("message.add", { text: `${i}` }).then(
            () => "taken",
            (error: { code?: string }) => error.code,
          ),
      );
      assertEquals(await Promise.all(writes), Array(5).fill("fenced"));
      await first.lost;
    });
    assertEquals(lines.length, 1);
    await sleep(20);
    assertEquals(told, 1);
    assertEquals(await first.lost, await first.lost);
    // From here on, nothing reaches the store: not callers, requests, timers or checks.
    const commits = store.commits();
    await first.call("message.add", { text: "after" }).catch(() => {});
    await first.emit("message.ping").catch(() => {});
    await first.fetch(webhook("after"));
    await first.maintenance.write("DELETE FROM nodes", { actor: { kind: "person", id: "ana" } })
      .catch(() => {});
    clock.advance(60 * 60_000);
    await sleep(50);
    await first.close();
    await first.close();
    assertEquals(store.commits(), commits);
  } finally {
    await first.close();
    await second.close();
  }
});

test("an owner that keeps its store checks it while idle, and never when told not to", async () => {
  const store = counting(memoryStore());
  const clock = manualClock(START);
  const { plugin } = inbox();
  const runtime = await createRuntime({ store, plugins: [plugin], clock, warn: false });
  try {
    // Its start's own commits settle (Processors' positions a moment after they move), and
    // count as a check: the first one skips.
    await sleep(300);
    clock.advance(5_000);
    await sleep(10);
    const started = store.commits();
    // Every 5 s by default: an empty fenced commit, which passes.
    clock.advance(5_000);
    await sleep(10);
    assertEquals(store.commits(), started + 1);
    // A commit since checks the fence itself: the next check skips.
    await runtime.call("message.add", { text: "a" });
    await runtime.idle();
    await sleep(300);
    const written = store.commits();
    clock.advance(5_000);
    await sleep(10);
    assertEquals(store.commits(), written);
    clock.advance(5_000);
    await sleep(10);
    assertEquals(store.commits(), written + 1);
    // It's serving as ever.
    const answer = await runtime.fetch(health());
    assertEquals([answer.status, await answer.text()], [200, "ok"]);
  } finally {
    await runtime.close();
  }
  const never = counting(memoryStore());
  const later = manualClock(START);
  const quiet = await createRuntime({
    store: never,
    plugins: [plugin],
    clock: later,
    warn: false,
    fenceCheck: false,
  });
  await sleep(300);
  const before = never.commits();
  // Half a minute: no timer is due, and no check comes.
  later.advance(30_000);
  await sleep(20);
  assertEquals(never.commits(), before);
  await quiet.close();
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: [plugin], fenceCheck: 0 }),
    Error,
    "fenceCheck",
  );
});

test("a pool keeps a lost runtime answering 503, and opens it again idleMs after it was lost", async () => {
  // One store per org, shared by two processes' pools.
  const stores = new Map<string, Store>();
  const storeOf = (id: string) => {
    if (!stores.has(id)) stores.set(id, memoryStore());
    return stores.get(id)!;
  };
  const { plugin } = inbox();
  const opened = { here: 0, there: 0 };
  const open = (where: "here" | "there", fenceCheck: number | false) => async (id: string) => {
    opened[where]++;
    return await createRuntime({ store: storeOf(id), plugins: [plugin], warn: false, fenceCheck });
  };
  const here = runtimes(open("here", 20), { idleMs: 400 });
  const there = runtimes(open("there", false));
  try {
    const mine = (await here.get("acme"))!;
    await here.get("beta");
    // Another process opens acme: here, acme's runtime finds out (idle, by its check).
    const theirs = (await there.get("acme"))!;
    await logged(() => lostWithin(mine));
    // The other orgs here are still this process's own.
    const beta = await (await here.get("beta"))!.fetch(page());
    assertEquals([beta.status, await beta.text()], [200, "page"]);
    // Asked for, it's the same one, answering 503: not opened again, so theirs isn't fenced.
    for (let i = 0; i < 5; i++) {
      assertEquals(await here.get("acme"), mine);
      const answer = await (await here.get("acme"))!.fetch(page());
      assertEquals(answer.status, 503);
      await answer.body?.cancel();
      await sleep(40);
    }
    assertEquals(opened.here, 2);
    const served = await theirs.fetch(page());
    assertEquals([served.status, await served.text()], [200, "page"]);
    // Asking didn't keep it: idleMs after it was lost, the sweep forgets it, and the next use
    // opens it again (taking it back from the other process, which finds out in turn).
    const until = Date.now() + 3_000;
    while (here.peek("acme") === mine && Date.now() < until) {
      await here.get("acme");
      await sleep(50);
    }
    assert(here.peek("acme") !== mine, "the lost one was forgotten");
    const again = (await here.get("acme"))!;
    assert(again !== mine);
    assertEquals(opened.here, 3);
    const back = await again.fetch(page());
    assertEquals([back.status, await back.text()], [200, "page"]);
  } finally {
    await here.close();
    // Theirs was taken back: its close finds out, and says so.
    await logged(() => there.close());
  }
});
