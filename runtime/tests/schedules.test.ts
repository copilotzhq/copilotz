/**
 * Schedules: time calls Actions. Plugins declare recurring timers (patched
 * and removed like configuration); code sets its own (`ctx.schedule`). Each
 * occurrence is a call of its own id, a failed one is tried again after a
 * growing wait, one cut short by a stop runs again when the owner starts,
 * and the owner keeps declared timers as the plugins declare them.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  manualClock,
  type Plugins,
  type Store,
  type Timer,
  TIMERS,
} from "../mod.ts";
import { fingerprint } from "../registry.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `s_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const T0 = "2026-10-27T12:00:00.000Z";
const MINUTE = 60_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** Attempts per `n`, and what time told each attempt, across a test. */
let tries: Record<number, number> = {};
let told: unknown[] = [];

const app = definePlugin({
  name: "app",
  collections: {
    tick: defineCollection({
      schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    }),
  },
  actions: {
    // Fails its first `fail` attempts.
    "tick.add": defineAction({
      input: {
        type: "object",
        properties: { n: { type: "number" }, fail: { type: "number" } },
        required: ["n"],
        additionalProperties: false,
      },
      run: async (ctx, { n, fail = 0 }) => {
        tries[n] = (tries[n] ?? 0) + 1;
        told.push(ctx.scheduled);
        if (tries[n] <= fail) throw new Error(`attempt ${tries[n]} fails`);
        await ctx.db.collection("tick").insertOne({ n });
        return tries[n];
      },
    }),
    // Sets timers from code: on its own, or with other writes in a transaction.
    "remind.set": defineAction({
      input: {
        type: "object",
        properties: {
          n: { type: "number" },
          when: { type: "object" },
          tx: { type: "boolean" },
          fail: { type: "boolean" },
        },
        required: ["n", "when"],
      },
      run: async (ctx, { n, when, tx, fail }) => {
        // deno-lint-ignore no-explicit-any
        const options = when as any;
        const id = tx
          ? await ctx.transaction(async (t) => {
            await t.db.collection("tick").insertOne({ n: -n });
            return t.schedule("tick.add", { n }, options);
          })
          : await ctx.schedule("tick.add", { n }, options);
        if (fail && !ctx.retry) throw new Error("fails once, after setting its timer");
        return id;
      },
    }),
    "remind.cancel": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id }) => ctx.unschedule(id),
    }),
  },
});

async function boot(store: Store, plugins: Plugins = [], clock = manualClock(T0)) {
  tries = {};
  told = [];
  const runtime = await createRuntime({ store, plugins: [app, ...plugins], clock });
  await runtime.idle();
  const timers = async () =>
    (await store.find(TIMERS, {}, { sort: { _id: 1 } })) as unknown as Timer[];
  const ticks = async () => (await store.find("tick", {}, { sort: { n: 1 } })).map((t) => t.n);
  /** Moves time on, and waits for what came due to finish. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    await runtime.idle();
  };
  return { runtime, clock, timers, ticks, advance };
}

/** The calls in the log: `type id#attempt`. */
const calls = async (store: Store) =>
  (await store.events(0)).filter((e: Event) =>
    e.type.startsWith("action.") && e.data.action === "tick.add"
  )
    .map((e) =>
      `${e.type.slice(7)} ${e.type === "action.started" ? e.id : e.cause}#${e.data.attempt}`
    );

each(
  "a declared schedule calls its Action each time it comes due, as a call of its own",
  async (make) => {
    const store = await make();
    const { runtime, timers, ticks, advance } = await boot(store, [
      definePlugin({
        name: "beat",
        schedules: { heartbeat: { every: "1m", call: "tick.add", input: { n: 1 } } },
      }),
    ]);
    assertEquals((await timers()).map((t) => [t._id, t.at, t.every, t.declared]), [
      ["heartbeat", at(MINUTE), MINUTE, true],
    ]);
    await advance(30_000);
    assertEquals(await ticks(), []);
    await advance(30_000);
    await advance(MINUTE);
    assertEquals(await ticks(), [1, 1]);
    // Ten minutes of nothing running: it fires once, not ten times, and keeps its beat.
    await advance(10 * MINUTE);
    assertEquals(await ticks(), [1, 1, 1]);
    assertEquals((await timers())[0].at, at(13 * MINUTE));
    assertEquals(await calls(store), [
      `started heartbeat@${at(MINUTE)}#1`,
      `completed heartbeat@${at(MINUTE)}#1`,
      `started heartbeat@${at(2 * MINUTE)}#1`,
      `completed heartbeat@${at(2 * MINUTE)}#1`,
      `started heartbeat@${at(3 * MINUTE)}#1`,
      `completed heartbeat@${at(3 * MINUTE)}#1`,
    ]);
    await runtime.close();
  },
);

each("a cron schedule comes due in its timezone", async (make) => {
  const store = await make();
  const { runtime, clock, timers, ticks } = await boot(store, [
    definePlugin({
      name: "daily",
      schedules: {
        close: {
          cron: "5 0 * * *",
          timezone: "America/Sao_Paulo",
          call: "tick.add",
          input: { n: 7 },
        },
        // Without a timezone, UTC: whatever the host's own.
        utc: { cron: "5 0 * * *", call: "tick.add", input: { n: 6 } },
      },
    }),
  ]);
  // 00:05 in São Paulo is 03:05 UTC.
  assertEquals((await timers()).map((t) => [t._id, t.at]), [
    ["close", "2026-10-28T03:05:00.000Z"],
    ["utc", "2026-10-28T00:05:00.000Z"],
  ]);
  clock.set("2026-10-28T00:05:00.000Z");
  await runtime.idle();
  assertEquals(await ticks(), [6]);
  clock.set("2026-10-28T03:04:59.999Z");
  await runtime.idle();
  assertEquals(await ticks(), [6]);
  clock.set("2026-10-28T03:05:00.000Z");
  await runtime.idle();
  assertEquals(await ticks(), [6, 7]);
  assertEquals((await timers())[0].at, "2026-10-29T03:05:00.000Z");
  await runtime.close();
});

each("code sets timers: once, every so long, replaced by id, removed", async (make) => {
  const store = await make();
  const { runtime, timers, ticks, advance } = await boot(store);
  const once = await runtime.call<string>("remind.set", { n: 1, when: { at: at(5 * MINUTE) } });
  const often = await runtime.call<string>("remind.set", {
    n: 2,
    when: { every: "2m", id: "often" },
  });
  assertEquals(often, "often");
  // In a transaction, with its other writes.
  await runtime.call("remind.set", { n: 3, tx: true, when: { at: at(MINUTE), id: "soon" } });
  assertEquals(
    (await timers()).map((t) => [t._id, t.at]).sort(),
    [
      [once, at(5 * MINUTE)],
      ["often", at(2 * MINUTE)],
      ["soon", at(MINUTE)],
    ].sort(),
  );
  await advance(MINUTE);
  assertEquals(await ticks(), [-3, 3]);
  await advance(MINUTE);
  assertEquals(await ticks(), [-3, 2, 3]);
  // Scheduling an id again replaces its timer.
  await runtime.call("remind.set", { n: 4, when: { every: "10m", id: "often" } });
  await advance(3 * MINUTE);
  assertEquals(await ticks(), [-3, 1, 2, 3]);
  // A one-off goes once it ran; removing a timer stops it.
  assertEquals((await timers()).map((t) => t._id), ["often"]);
  assertEquals(await runtime.call("remind.cancel", { id: "often" }), true);
  assertEquals(await runtime.call("remind.cancel", { id: "often" }), false);
  await advance(60 * MINUTE);
  assertEquals(await ticks(), [-3, 1, 2, 3]);
  assertEquals(await timers(), []);
  // A time already past is due at once.
  await runtime.call("remind.set", { n: 8, when: { at: T0 } });
  await runtime.idle();
  assertEquals(await ticks(), [-3, 1, 2, 3, 8]);
  await runtime.close();
});

each("a timer set by a retried call is the same timer, not another", async (make) => {
  const store = await make();
  const { runtime, timers } = await boot(store);
  const input = { n: 1, fail: true, when: { at: at(MINUTE) } };
  await assertRejects(() => runtime.call("remind.set", input, { id: "c1" }));
  const id = await runtime.call<string>("remind.set", input, { id: "c1" });
  assertEquals(id, "c1:timer.1");
  assertEquals((await timers()).map((t) => t._id), ["c1:timer.1"]);
  await runtime.close();
});

each("a failed occurrence is tried again as the same call, after a growing wait", async (make) => {
  const store = await make();
  const { runtime, timers, ticks, advance } = await boot(store, [
    definePlugin({
      name: "flaky",
      actions: {
        // Its Action fails twice, then succeeds.
        "flaky.set": defineAction({
          input: { type: "object" },
          run: (ctx) => ctx.schedule("tick.add", { n: 5, fail: 2 }, { at: at(MINUTE), id: "f" }),
        }),
      },
    }),
  ]);
  await runtime.call("flaky.set", {});
  const occurrence = `f@${at(MINUTE)}`;
  await advance(MINUTE);
  // A retry is a timer of its own, calling as the occurrence: 10 s later, then 30 s.
  assertEquals((await timers()).map((t) => [t._id, t.at, t.retry]), [
    [occurrence, at(MINUTE + 10_000), true],
  ]);
  await advance(10_000);
  assertEquals((await timers()).map((t) => [t._id, t.at]), [
    [occurrence, at(MINUTE + 40_000)],
  ]);
  await advance(29_999);
  assertEquals(await ticks(), []);
  await advance(1);
  assertEquals(await ticks(), [5]);
  assertEquals(await timers(), []);
  // Every attempt knows the time it's for.
  assertEquals(told, Array(3).fill({ timer: "f", at: at(MINUTE) }));
  assertEquals(await calls(store), [
    `started ${occurrence}#1`,
    `failed ${occurrence}#1`,
    `retried ${occurrence}#2`,
    `failed ${occurrence}#2`,
    `retried ${occurrence}#3`,
    `completed ${occurrence}#3`,
  ]);
  await runtime.close();
});

each("past its retries an occurrence is given up, and a one-off goes", async (make) => {
  const store = await make();
  const { runtime, timers, ticks, advance } = await boot(store, [
    definePlugin({
      name: "doomed",
      actions: {
        "doomed.set": defineAction({
          input: { type: "object" },
          run: (ctx) =>
            ctx.schedule("tick.add", { n: 9, fail: 5 }, { at: at(MINUTE), id: "d", retries: 1 }),
        }),
      },
    }),
  ]);
  await runtime.call("doomed.set", {});
  await advance(MINUTE);
  await advance(10_000);
  assertEquals(await timers(), []);
  assertEquals(await ticks(), []);
  assertEquals(tries[9], 2);
  await runtime.close();
});

each(
  "an occurrence a stop cut short runs again, as itself, when the owner starts",
  async (make) => {
    const store = await make();
    // A previous owner claimed it and started the call, then stopped before any outcome.
    const { epoch } = await store.open();
    const due = at(-MINUTE);
    const occurrence = `beat@${due}`;
    await store.transaction(epoch, async (tx) => {
      await tx.replace(TIMERS, { _id: "beat" }, {
        call: "tick.add",
        input: { n: 1 },
        every: MINUTE,
        retries: 2,
        at: at(30_000),
        running: [occurrence],
      }, { upsert: true });
      tx.emit({
        id: occurrence,
        type: "action.started",
        data: {
          action: "tick.add",
          input: { n: 1 },
          inputHash: await fingerprint("tick.add", { n: 1 }),
          attempt: 1,
        },
      });
    });
    const { runtime, ticks, timers } = await boot(store);
    assertEquals(await ticks(), [1]);
    assertEquals(await calls(store), [
      `started ${occurrence}#1`,
      `retried ${occurrence}#2`,
      `completed ${occurrence}#2`,
    ]);
    // The timer itself is as it was: next due 30 s from now.
    assertEquals((await timers()).map((t) => [t._id, t.at]), [["beat", at(30_000)]]);
    await runtime.close();
  },
);

each(
  "declared timers are kept as declared: patched, removed, or left as they are",
  async (make) => {
    const store = await make();
    // What an earlier start left: three declared timers, one since changed and one since removed.
    const { epoch } = await store.open();
    await store.transaction(epoch, async (tx) => {
      for (
        const [id, every] of [["kept", MINUTE], ["changed", MINUTE], ["gone", MINUTE]] as const
      ) {
        await tx.replace(TIMERS, { _id: id }, {
          call: "tick.add",
          input: { n: 1 },
          every,
          retries: 2,
          at: at(30_000),
          declared: true,
        }, { upsert: true });
      }
    });
    const declared = definePlugin({
      name: "declared",
      schedules: {
        kept: { every: "1m", call: "tick.add", input: { n: 1 } },
        changed: { every: "1m", call: "tick.add", input: { n: 1 } },
        gone: { every: "1m", call: "tick.add", input: { n: 1 } },
      },
    });
    // A later plugin patches one (cron instead of every) and removes another.
    const patch = definePlugin({
      name: "patch",
      schedules: { changed: { every: null, cron: "0 * * * *" }, gone: null },
    });
    const { runtime, timers } = await boot(store, [declared, patch]);
    assertEquals((await timers()).map((t) => [t._id, t.at, t.cron, t.every]), [
      ["changed", "2026-10-27T13:00:00.000Z", "0 * * * *", undefined],
      ["kept", at(30_000), undefined, MINUTE],
    ]);
    await runtime.close();
  },
);

each("a host whose clock only rings calls wake()", async (make) => {
  const store = await make();
  let now = Date.parse(T0);
  const alarms: number[] = [];
  const alarm = { now: () => now, wake: (when: number) => (alarms.push(when), () => {}) };
  const { runtime, ticks } = await boot(store, [], alarm as never);
  await runtime.call("remind.set", { n: 1, when: { at: at(MINUTE) } });
  assertEquals(alarms.at(-1), Date.parse(at(MINUTE)));
  now += MINUTE;
  await runtime.wake();
  await runtime.idle();
  assertEquals(await ticks(), [1]);
  await runtime.close();
});

test("timers that can't run are refused when set, and declared ones stop the start", async () => {
  const { runtime } = await boot(memoryStore());
  for (
    const [input, message] of [
      [{ n: 1, when: {} }, "one of `at`, `cron` or `every`"],
      [{ n: 1, when: { at: at(1), every: "1m" } }, "one of `at`, `cron` or `every`"],
      [{ n: 1, when: { cron: "not cron" } }, "Not a cron expression"],
      [{ n: 1, when: { every: "fortnightly" } }, "every must be"],
      [{ n: 1, when: { at: "someday" } }, "Not a time"],
    ] as const
  ) {
    await assertRejects(() => runtime.call("remind.set", input), Error, message);
  }
  await runtime.close();

  const bad = (schedules: Record<string, unknown>) =>
    createRuntime({
      store: memoryStore(),
      clock: manualClock(T0),
      plugins: [app, definePlugin({ name: "bad", schedules: schedules as never })],
    });
  await assertRejects(
    () => bad({ x: { every: "1m", call: "nope" } }),
    Error,
    'Schedule "x": calls unknown action "nope"',
  );
  await assertRejects(
    () => bad({ x: { every: "1m", call: "tick.add", input: { n: "one" } } }),
    Error,
    'Schedule "x": input',
  );
  await assertRejects(
    () => bad({ x: { at: T0, call: "tick.add", input: { n: 1 } } }),
    Error,
    "not `at`",
  );
  await assertRejects(
    () => bad({ x: { cron: "61 * * * *", call: "tick.add", input: { n: 1 } } }),
    Error,
    "Not a cron expression",
  );
  // Code can't take over a declared timer.
  const r = await createRuntime({
    store: memoryStore(),
    clock: manualClock(T0),
    plugins: [
      app,
      definePlugin({
        name: "d",
        schedules: { mine: { every: "1m", call: "tick.add", input: { n: 1 } } },
      }),
    ],
  });
  await assertRejects(
    () => r.call("remind.set", { n: 1, when: { at: at(1), id: "mine" } }),
    Error,
    "declared by a plugin",
  );
  await r.close();
});
