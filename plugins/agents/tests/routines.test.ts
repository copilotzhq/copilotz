/**
 * Routines: a message sent to an agent on a schedule. Time runs one as its
 * maker (its timer is always theirs, whoever changes it), posting in a new
 * chat named after it each run, or always in the same one, and each run is
 * recorded with the chat it made and how it went. Its maker or a manager
 * changes, pauses, resumes, runs or deletes it; a maker who left the space
 * makes its runs fail as forbidden, until a manager takes it over. Agents
 * make, list and cancel them from a conversation. And the schedules
 * themselves: their timers, next runs and words.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  manualClock,
  type Store,
  type Timer,
  TIMERS,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, type Prompt } from "../chat/mod.ts";
import { type ListedRoutine, type RoutineRun, routines } from "../routines/mod.ts";
import {
  describe,
  friendlier,
  instantOf,
  localOf,
  nextRuns,
  normalize,
  soon,
  whenOf,
} from "../routines/shared/schedule.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `r_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? `failed: ${error}`);

/** Monday, 8:00 UTC. */
const T0 = "2026-11-02T08:00:00.000Z";
const HOUR = 3_600_000;

/** What the routine tools answered, in order. */
let outputs: string[] = [];

/**
 * Agents answer "<name>: <what was said>"; one told "tool <name> <json>"
 * calls that tool, then answers with what it returned.
 */
const script: LlmAdapter = {
  async *generate({ messages, connection }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      outputs.push(text(last));
      yield { type: "text", text: "done" };
      return;
    }
    const said = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const m = said.match(/tool (\w+) (\{.*\})$/s);
    if (m) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: m[1], input: JSON.parse(m[2]) },
      };
    } else yield { type: "text", text: `${connection.model}: ${said}` };
  },
};

async function start(make: () => Store | Promise<Store>) {
  outputs = [];
  const clock = manualClock(T0);
  const store = await make();
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { s: { adapter: "s" } },
      agents: {
        lead: { instructions: "I lead.", model: "s/lead", default: true },
        researcher: { instructions: "I dig.", model: "s/researcher", default: true },
        scout: { instructions: "I scout.", model: "s/scout" },
      },
    },
    adapters: { llm: { s: script } },
  });
  const rt = await createRuntime({
    store,
    clock,
    plugins: [models, chat, ...access, routines, app],
  });
  await rt.idle();
  const advance = async (ms: number) => {
    clock.advance(ms);
    await rt.idle();
    // A run's send starts a turn: let it finish too.
    await rt.idle();
  };
  const timers = async () => (await store.find(TIMERS, {})) as unknown as Timer[];
  return { rt, advance, timers };
}

type Started = Awaited<ReturnType<typeof start>>;

const list = (s: Started, space: string, actor: Actor = ana) =>
  s.rt.query<ListedRoutine[]>("routine.list", { in: space }, { actor });
const runs = (s: Started, routine: string, actor: Actor = ana) =>
  s.rt.query<RoutineRun[]>("routine.runs", { routine }, { actor });
const history = (s: Started, thread: string, actor: Actor = ana) =>
  s.rt.query<Message[]>("message.history", { thread }, { actor });

async function launch(s: Started) {
  const { space } = await s.rt.call<{ space: string }>("space.create", { name: "Launch" }, {
    actor: ana,
  });
  await join(s.rt, space, bob, "editor", ana);
  await join(s.rt, space, cy, "viewer", ana);
  return space;
}

const daily = { kind: "daily", time: "09:00", timezone: "UTC" };

each(
  "a routine runs as its maker, on time, in a new chat each run or always the same",
  async (make) => {
    const s = await start(make);
    try {
      const space = await launch(s);
      const { routine: news } = await s.rt.call<{ routine: string }>("routine.create", {
        in: space,
        name: "Morning news",
        text: "What's new on our market?",
        agent: "researcher",
        schedule: daily,
      }, { actor: bob });
      const { routine: pulse } = await s.rt.call<{ routine: string }>("routine.create", {
        in: space,
        text: "@lead how are we doing?",
        agent: "lead",
        schedule: { kind: "hours", every: 1 },
        post: "same",
      }, { actor: ana });
      // Its timer is its maker's.
      const timer = (await s.timers()).find((t) => t._id === `routine:${news}`)!;
      assertEquals([timer.call, timer.cron, timer.actor?.id], ["routine.fire", "0 9 * * *", "bob"]);
      assertEquals((await list(s, space)).map((r) => r.name), [
        "Morning news",
        "How are we doing?",
      ]);

      // 9:00: both run. News asks the researcher, as Bob, in a chat named after it.
      await s.advance(HOUR);
      const [first] = await runs(s, news);
      assertEquals([first.outcome, first.due], ["sent", "2026-11-02T09:00:00.000Z"]);
      const said = await history(s, first.thread!, bob);
      assertEquals(said.map((m) => [m.from, m.text]), [
        ["bob", "What's new on our market?"],
        ["researcher", "researcher: bob: What's new on our market?"],
      ]);
      assertEquals(said[0].to, ["researcher"]);
      const thread = await s.rt.query<{ title?: string }[]>("thread.recent", { in: space }, {
        actor: bob,
      });
      assert(thread.some((t) => t.title === "Morning news"));

      // The next day, News posts in a new chat; Pulse, hourly, always in its first one.
      await s.advance(24 * HOUR);
      const newsRuns = await runs(s, news);
      assertEquals(newsRuns.length, 2);
      assert(newsRuns[0].thread !== newsRuns[1].thread);
      const pulseRuns = await runs(s, pulse);
      assert(pulseRuns.length >= 2, `pulse ran ${pulseRuns.length} times`);
      assertEquals(new Set(pulseRuns.map((r) => r.thread)).size, 1);
      const [listed] = (await list(s, space)).filter((r) => r._id === pulse);
      assertEquals([listed.thread, listed.last?.outcome, listed.runs], [
        pulseRuns[0].thread,
        "sent",
        pulseRuns.length,
      ]);
      assert(listed.next && listed.next > listed.last!.at);
      // A viewer sees them, and their runs; someone outside, nothing.
      assertEquals((await list(s, space, cy)).length, 2);
      assertEquals((await runs(s, news, cy)).length, 2);
      const dee: Actor = { kind: "person", id: "dee" };
      assertEquals(await list(s, space, dee), []);
    } finally {
      await s.rt.close();
    }
  },
);

each("who changes a routine, and a maker who left the space", async (make) => {
  const s = await start(make);
  try {
    const space = await launch(s);
    const make_ = (actor: Actor, more: Record<string, unknown> = {}) =>
      s.rt.call<{ routine: string }>("routine.create", {
        in: space,
        text: "Status?",
        agent: "lead",
        schedule: daily,
        ...more,
      }, { actor });
    // A viewer can't make one; nor ask an agent that doesn't answer here; nor at a past time.
    assertEquals(await refused(make_(cy)), "forbidden");
    assertEquals(await refused(make_(bob, { agent: "scout" })), "invalid");
    assertEquals(
      await refused(make_(bob, { schedule: { kind: "once", at: "2020-01-01T09:00" } })),
      "invalid",
    );
    assertEquals(
      await refused(make_(bob, { schedule: { kind: "cron", cron: "every day" } })),
      "invalid",
    );
    const { routine: bobs } = await make_(bob);
    const { routine: anas } = await make_(ana);

    // Bob can't change Ana's; Ana (a manager) changes Bob's, and it still runs as Bob.
    assertEquals(
      await refused(s.rt.call("routine.update", { routine: anas, text: "Mine." }, { actor: bob })),
      "forbidden",
    );
    assertEquals(
      await refused(s.rt.call("routine.run", { routine: anas }, { actor: bob })),
      "forbidden",
    );
    await s.rt.call("routine.update", {
      routine: bobs,
      text: "Status, please?",
      schedule: { kind: "weekdays", time: "10:30", timezone: "Europe/Lisbon" },
    }, { actor: ana });
    const timer = (await s.timers()).find((t) => t._id === `routine:${bobs}`)!;
    assertEquals([timer.cron, timer.timezone, timer.actor?.id], [
      "30 10 * * 1-5",
      "Europe/Lisbon",
      "bob",
    ]);
    const [listed] = (await list(s, space, bob)).filter((r) => r._id === bobs);
    assertEquals([listed.editable, listed.left], [true, false]);
    assertEquals((await list(s, space, bob)).find((r) => r._id === anas)?.editable, false);

    // Bob leaves: his routine can't run as him. It says so, and its run is forbidden.
    await s.rt.call("space.leave", { space }, { actor: bob });
    assertEquals((await list(s, space)).find((r) => r._id === bobs)?.left, true);
    await s.advance(3 * HOUR); // 10:30 in Lisbon is 10:30 UTC in November.
    const [failed] = await runs(s, bobs);
    assertEquals(failed.outcome, "forbidden");
    assertStringIncludes(failed.error!, "bob can't write in this space anymore");
    assertEquals((await list(s, space)).find((r) => r._id === bobs)?.last?.outcome, "forbidden");

    // Ana takes it over: it runs as her now.
    await s.rt.call("routine.update", { routine: bobs, adopt: true }, { actor: ana });
    const adopted = (await s.timers()).find((t) => t._id === `routine:${bobs}`)!;
    assertEquals(adopted.actor?.id, "ana");
    const ran = await s.rt.call<{ outcome: string; thread: string }>("routine.run", {
      routine: bobs,
    }, { actor: ana });
    await s.rt.idle();
    assertEquals(ran.outcome, "sent");
    assertEquals((await history(s, ran.thread)).map((m) => m.from), ["ana", "lead"]);
    const [now] = await runs(s, bobs);
    assertEquals([now.outcome, now.by, now.due], ["sent", "ana", undefined]);
  } finally {
    await s.rt.close();
  }
});

each(
  "paused, a routine doesn't run; resumed, it does; deleted, it and its runs go",
  async (make) => {
    const s = await start(make);
    try {
      const space = await launch(s);
      const { routine } = await s.rt.call<{ routine: string }>("routine.create", {
        in: space,
        text: "Status?",
        agent: "lead",
        schedule: daily,
      }, { actor: bob });
      await s.rt.call("routine.pause", { routine }, { actor: bob });
      assertEquals((await s.timers()).filter((t) => t._id === `routine:${routine}`), []);
      const [paused] = await list(s, space);
      assert(paused.paused && !paused.next);
      await s.advance(2 * HOUR);
      assertEquals(await runs(s, routine), []);
      // Run now still runs it, paused; resumed, its timer is back.
      assertEquals(
        (await s.rt.call<{ outcome: string }>("routine.run", { routine }, { actor: bob })).outcome,
        "sent",
      );
      await s.rt.call("routine.resume", { routine }, { actor: ana });
      const back = (await s.timers()).find((t) => t._id === `routine:${routine}`)!;
      assertEquals(back.actor?.id, "bob");
      await s.advance(24 * HOUR);
      assertEquals((await runs(s, routine)).map((r) => r.outcome), ["sent", "sent"]);
      // Deleted: its timer and runs go; its chats stay.
      const [{ thread }] = await runs(s, routine);
      await s.rt.call("routine.delete", { routine }, { actor: bob });
      assertEquals(await list(s, space), []);
      assertEquals(await runs(s, routine), []);
      assertEquals((await s.timers()).filter((t) => t._id === `routine:${routine}`), []);
      assertEquals((await history(s, thread!, bob)).length, 2);
    } finally {
      await s.rt.close();
    }
  },
);

each("agents make, list and cancel routines for the person they work for", async (make) => {
  const s = await start(make);
  try {
    const space = await launch(s);
    const ask = async (said: string, thread?: string) => {
      const sent = await s.rt.call<{ thread: string }>(
        "chat.send",
        thread ? { thread, text: said } : { text: `@lead ${said}`, in: space },
        { actor: ana },
      );
      await s.rt.idle();
      return sent.thread;
    };
    const thread = await ask("hello");
    // Offered here: Ana may write in Launch.
    const prompt = await s.rt.query<Prompt>("thread.prompt", { thread, agent: "lead" }, {
      actor: ana,
    });
    assertEquals(
      prompt.tools.map((t) => t.name).filter((n) => n.includes("routine")).sort(),
      ["cancel_routine", "list_routines", "schedule_routine"],
    );
    await ask(
      `tool schedule_routine ${
        JSON.stringify({
          name: "Monday report",
          text: "Remind me to send the weekly report",
          schedule: { kind: "weekly", days: [1], time: "09:00", timezone: "America/Sao_Paulo" },
        })
      }`,
      thread,
    );
    assertStringIncludes(outputs[0], 'Made it: "Monday report"');
    assertStringIncludes(outputs[0], "Mondays at 9:00 AM (Sao Paulo time), asks @lead");
    assertStringIncludes(outputs[0], "It runs as ana");
    const [made] = await list(s, space);
    assertEquals([made.by, made.agent, made.post], ["ana", "lead", "new"]);
    assertEquals((await s.timers()).find((t) => t._id === `routine:${made._id}`)?.actor?.id, "ana");
    await ask(`tool list_routines {}`, thread);
    assertStringIncludes(outputs[1], `"Monday report" [${made._id}]: Mondays at 9:00 AM`);
    await ask(
      `tool schedule_routine ${JSON.stringify({ text: "x", schedule: { kind: "daily" } })}`,
      thread,
    );
    assertStringIncludes(outputs[2], "Couldn't make it: Say at what time");
    await ask(`tool cancel_routine ${JSON.stringify({ routine: "monday report" })}`, thread);
    assertEquals(outputs[3], 'Deleted "Monday report". The chats it posted in stay.');
    assertEquals(await list(s, space), []);
  } finally {
    await s.rt.close();
  }
});

test("schedules: checked and completed, as timers, in words", () => {
  const now = Date.parse(T0);
  assertEquals(normalize({ kind: "daily", time: "9:05" }, now), {
    kind: "daily",
    time: "09:05",
    timezone: "UTC",
  });
  assertEquals(
    normalize({ kind: "weekly", days: [5, 1, 1], time: "17:30", timezone: "Asia/Tokyo" }, now),
    {
      kind: "weekly",
      days: [1, 5],
      time: "17:30",
      timezone: "Asia/Tokyo",
    },
  );
  // A once, given on a wall clock in its timezone, is kept as an instant.
  assertEquals(
    normalize({ kind: "once", at: "2026-11-03T09:00", timezone: "America/New_York" }, now),
    { kind: "once", at: "2026-11-03T14:00:00.000Z", timezone: "America/New_York" },
  );
  for (
    const [given, said] of [
      [{ kind: "daily" }, "Say at what time"],
      [{ kind: "daily", time: "25:00" }, "Say at what time"],
      [{ kind: "weekly", days: [], time: "09:00" }, "at least one day"],
      [{ kind: "hours", every: 0 }, "Every 1 to 168 hours"],
      [{ kind: "once", at: "2026-11-01T09:00" }, "That time has passed"],
      [{ kind: "cron", cron: "0 9 * *" }, "five fields"],
      [{ kind: "cron", cron: "0 9 31 2 *" }, "never comes round"],
      [{ kind: "daily", time: "09:00", timezone: "Mars/Olympus" }, "isn't a timezone"],
    ] as const
  ) {
    assertThrows(() => normalize(given as never, now), Error, said);
  }
  assertEquals(whenOf({ kind: "weekdays", time: "07:15", timezone: "UTC" }), {
    cron: "15 7 * * 1-5",
    timezone: "UTC",
  });
  assertEquals(whenOf({ kind: "hours", every: 3 }), { every: 3 * HOUR });

  // The next runs, in their timezone, across a change of the clocks.
  const lisbon = { kind: "daily", time: "09:00", timezone: "Europe/Lisbon" } as const;
  assertEquals(
    nextRuns(lisbon, { from: Date.parse("2026-10-24T12:00:00Z") }).map((d) => d.toISOString()),
    ["2026-10-25T09:00:00.000Z", "2026-10-26T09:00:00.000Z", "2026-10-27T09:00:00.000Z"],
  );
  assertEquals(
    nextRuns(lisbon, { from: Date.parse("2026-03-28T12:00:00Z") }).map((d) => d.toISOString()),
    ["2026-03-29T08:00:00.000Z", "2026-03-30T08:00:00.000Z", "2026-03-31T08:00:00.000Z"],
  );
  assertEquals(
    nextRuns({ kind: "weekdays", time: "09:00", timezone: "UTC" }, {
      from: Date.parse("2026-10-30T10:00:00Z"), // Friday, after nine.
      count: 2,
    }).map((d) => d.toISOString()),
    ["2026-11-02T09:00:00.000Z", "2026-11-03T09:00:00.000Z"],
  );
  // Every few hours keeps the beat it started on.
  assertEquals(
    nextRuns({ kind: "hours", every: 4 }, {
      from: Date.parse("2026-11-02T13:00:00Z"),
      since: "2026-11-02T08:30:00.000Z",
      count: 2,
    }).map((d) => d.toISOString()),
    ["2026-11-02T16:30:00.000Z", "2026-11-02T20:30:00.000Z"],
  );
  assertEquals(
    nextRuns({ kind: "once", at: "2026-11-01T00:00:00.000Z", timezone: "UTC" }, { from: now }),
    [],
  );

  const words = (s: Parameters<typeof describe>[0], here?: string) =>
    describe(s, { locale: "en-US", ...(here ? { here } : {}) });
  assertEquals(
    words({ kind: "daily", time: "09:00", timezone: "UTC" }, "UTC"),
    "Every day at 9:00 AM",
  );
  assertEquals(
    words({ kind: "weekly", days: [1, 4], time: "17:30", timezone: "Europe/Lisbon" }, "UTC"),
    "Mondays and Thursdays at 5:30 PM (Lisbon time)",
  );
  assertEquals(
    words({ kind: "weekly", days: [0, 6], time: "10:00", timezone: "UTC" }, "UTC"),
    "Weekends at 10:00 AM",
  );
  assertEquals(words({ kind: "hours", every: 1 }), "Every hour");
  assertEquals(words({ kind: "hours", every: 6 }), "Every 6 hours");
  assertEquals(
    words({ kind: "cron", cron: "0 9 * * 1-5", timezone: "UTC" }, "UTC"),
    "Weekdays at 9:00 AM",
  );
  assertEquals(
    words({ kind: "cron", cron: "*/15 * * * *", timezone: "UTC" }, "UTC"),
    "On a custom schedule",
  );
  assertEquals(
    words(
      { kind: "once", at: "2026-11-03T14:00:00.000Z", timezone: "America/New_York" },
      "America/New_York",
    ),
    "Once, on Tue, Nov 3, 9:00 AM",
  );
  assertEquals(friendlier("30 8 * * 1,3,5", "UTC"), {
    kind: "weekly",
    days: [1, 3, 5],
    time: "08:30",
    timezone: "UTC",
  });
  assertEquals(friendlier("0 9 1 * *", "UTC"), undefined);

  // Wall clocks and instants, in a timezone, both ways.
  assertEquals(
    new Date(instantOf("2026-07-01T09:30", "Asia/Kolkata")).toISOString(),
    "2026-07-01T04:00:00.000Z",
  );
  assertEquals(localOf("2026-07-01T04:00:00.000Z", "Asia/Kolkata"), "2026-07-01T09:30");

  // How soon, shortly.
  const at = (iso: string) => new Date(iso);
  const opts = { now, locale: "en-US" };
  assertEquals(soon(at("2026-11-02T08:20:00Z"), "UTC", opts), "in 20 minutes");
  assertEquals(soon(at("2026-11-02T11:00:00Z"), "UTC", opts), "in 3 hours");
  assertEquals(soon(at("2026-11-03T09:00:00Z"), "UTC", opts), "Tomorrow, 9:00 AM");
  assertEquals(soon(at("2026-11-06T09:00:00Z"), "UTC", opts), "Fri, 9:00 AM");
  assertEquals(soon(at("2026-11-20T09:00:00Z"), "UTC", opts), "Nov 20, 9:00 AM");
});
