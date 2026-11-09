---
title: "Chapter 27: Routines on a schedule"
description: "Rebuild Copilotz's routines for one person: a message sent to an agent on a schedule, with time as one more caller of Actions, every run recorded, and tests that move time with a manual clock."
section: Build Compass
order: 270
status: stable
---

# Chapter 27: Routines on a schedule

> Part 8, skills and routines · Requires: Chapter 26 · Code: `lesson-8.2`

## The pain

Every morning you open Compass and type the same thing: "How is the launch going?" North answers
well, but only when you remember to ask. The day you forget is the day something slipped.

## The problem

Nobody is typing when the message should go out, so something else has to send it. That something
must not be a second way in: what it sends should pass the same rules as you, be recorded the same
way, and reach only what you reach. It has to survive the app stopping and starting, never send one
morning's message twice, and leave a trace of each run: when, in which chat, and how it went. And it
has to be testable without waiting until nine o'clock.

## The solution

A **routine** is a message sent to an agent on a schedule, in a space: what to send, to whom, when
(every day, weekdays or some days at a time, every few hours, or once, in a timezone), and where it
posts: always the same chat, or a new one each run. `plugins/routines` rebuilds Copilotz's routines
plugin for one person, with the same contract: the `routine` and `routineRun` collections, the
Actions `routine.create`, `routine.update`, `routine.pause`, `routine.resume`, `routine.delete` and
`routine.run`, and the queries `routine.list` and `routine.runs`.

```text
plugins/routines/
  mod.ts  contract.ts
  collections/routine.ts  collections/run.ts
  actions/create.ts  update.ts  pause.ts  resume.ts  delete.ts  run.ts  fire.ts
  shared/schedule.ts  shared/routines.ts  shared/fire.ts
  views/web/…  views/terminal/routines.ts  resources/commands.ts
  web.tsx  terminal.ts
```

### Time is a caller

The runtime already knows time. Any Action can **set a timer**: `ctx.schedule(action, input,
when)`
has time call an Action with an input, once (`at`), by a cron expression in a timezone (`cron`,
`timezone`), or every so long (`every`). Each timer is a document in `sys.timers`, written with
whatever else its commit writes, and a timer **set by an actor runs as them**. Scheduling the same
`id` again replaces it. `routine.create` (`actions/create.ts`) writes the routine and its timer in
one transaction:

```ts
run: async (ctx, input) => {
  const by = personOf(ctx.actor);
  if (!by || ctx.actor?.kind !== "person") throw forbidden("A routine is a person's: it runs as whoever makes it.");
  await writable(ctx, input.in);
  const schedule = normalize(input.schedule as Given);
  await answersIn(ctx, input.in, input.agent);
  // … which chat it posts in
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const when = timing(schedule);
  await ctx.transaction(async (tx) => {
    await tx.db.collection("routine").insertOne({
      _id: id,
      in: input.in,
      name: input.name?.trim() || nameFrom(input.text),
      text: input.text.trim(),
      agent: input.agent,
      schedule,
      post,
      // … thread, chatName
      by,
      at,
      ...(input.paused ? { paused: at } : when),
      runs: 0,
    });
    if (!input.paused) tx.schedule("routine.fire", { routine: id }, { ...whenOf(schedule), id: timerOf(id) });
  });
  return { routine: id, ...(input.paused ? {} : when) };
},
```

There's no routine without its timer, nor a timer without its routine: they commit together. The
timer's id is the routine's (`routine:<id>`), so changing the schedule later (`routine.update`,
`routine.resume`) sets the same timer again instead of adding one; `routine.pause` and
`routine.delete` take it away with `unschedule`.

`whenOf` (`shared/schedule.ts`) turns a schedule people say into what the runtime takes:

```ts
export function whenOf(s: Schedule): When {
  if (s.kind === "hours") return { every: s.every * HOUR };
  if (s.kind === "once") return { at: s.at };
  const [hour, minute] = s.time.split(":").map(Number);
  const days = s.kind === "daily" ? "*" : daysOf(s).join(",");
  return {
    cron: `${minute} ${hour} * * ${s.kind === "weekdays" ? "1-5" : days}`,
    timezone: s.timezone,
  };
}
```

"Weekdays at 10:30 in Lisbon" is `30 10 * * 1-5` in `Europe/Lisbon`: the runtime works out when that
is. The rest of `shared/schedule.ts` is plain functions over `Intl`: checking what was given
(`normalize`), the next runs to show (`nextRuns`), and the words for it (`describe`, "Weekdays at
10:30 AM (Lisbon time)").

### When it comes due

When a timer comes due, the runtime calls its Action as whoever set it, with an id of its own for
that occurrence, `<timer>@<the time it was due>`, so the log keeps each occurrence once however
often it's called; a failed one is tried again (twice, after 10 s and 30 s). The Action learns which
occurrence it is from `ctx.scheduled` (`actions/fire.ts`):

```ts
export const fireAction = defineAction({
  description: "Runs a routine when its time comes (time calls it)",
  input: byId,
  run: async (ctx, { routine }) => {
    const found = await ctx.as().db.collection<Routine>("routine").findOne({ _id: routine });
    if (!found || found.paused) {
      await ctx.as().unschedule(timerOf(routine));
      return { skipped: found ? "paused" : "gone" };
    }
    // Each occurrence once: its id is the routine and the time it was due.
    const due = ctx.scheduled?.at;
    return await fire(ctx, found, {
      id: due ? `${routine}@${due}` : `${routine}@${crypto.randomUUID()}`,
      ...(due ? { due } : {}),
    });
  },
});
```

`routine.fire` has no `allow`: nobody calls it from outside, only time (and the plugin's own code).
The run itself (`shared/fire.ts`) sends the message as the routine's maker, through the same
`chat.send` you use, and records how it went:

```ts
const maker = ctx.as({ kind: "person", id: routine.by });
// …
const { can } = await maker.call<{ can: boolean }>("space.can", {
  space: routine.in,
  verb: "write",
});
if (!can) {
  outcome = "forbidden";
  error = "This space is archived: the routine can't post there until it's brought back.";
} else {
  // …
  const sent = await maker.call<{ thread: string; message: string }>("chat.send", {
    // A new chat each run is named for the run, and its agent may name it for what it found.
    ...(into ? { thread: into } : {
      in: routine.in,
      title: each ? chatTitle(routine, run.due ?? at) : routine.name,
      ...(each ? { renamable: true } : {}),
    }),
    text: routine.text,
    to: [routine.agent],
    via: { kind: "routine", name: routine.name.slice(0, 120), path: routinePath(routine._id) },
  });
  // …
}
```

Three things to notice:

- **It runs as you.** `ctx.as(…)` acts as someone else (trusted code only), and the record says so.
  The message passes the same rules as one you type; an archived space refuses it, and the run says
  why instead of failing again and again.
- **`via`.** Chat's `chat.send` takes `via`: what sent the message for the person. The agent reads
  `Ana (via routine "Morning news"): …`, so it knows nobody is waiting at the keyboard.
- **A record of each run.** Every run, on time or "Run now" (`routine.run`, which calls the same
  `fire`), becomes a `routineRun` document with its outcome (`sent`, `failed`, `forbidden`), its
  chat and the time it was due; the routine keeps its `last` run, its count, and when it runs
  `next`. Both are written as the system (`ctx.as()`), so an archived space keeps them too.

### What's left out

Copilotz's routines are for a team: only a routine's maker or a space's managers change it, and a
maker who left the space makes its runs fail until a manager takes it over (`adopt`). Its runs also
carry the routine as their origin (`routine.origin`), so a yes can be given for that routine alone
(computers ask for one), and changing what it does makes a new version (`rev`) the old yes doesn't
cover. For one person, all of it is yours, and Compass has no computers to ask a yes. Copilotz's
also takes a cron expression, for experts; a day, weekdays, some days, every few hours or once say
what one person needs, and its `next` would need a cron library of its own.

### Showing them

On the web, `routinesWeb` (`web.tsx`) adds a Routines tab to every space (spaces' `spaceTabs`): each
routine, whom it asks and when, when it runs next and how its last run went, with "Run now", pause
or resume, and delete; and a form for a new one. A routine's page, `/routine/<id>`, lists its runs,
each with a link to its chat. In the terminal, `routinesTerminal` adds three commands:

```ts
const team = await term.runtime.query<{ here: string[]; default: string[] }>("thread.agents", {
  in: space,
});
const agent = team.default[0] ?? team.here[0];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
await term.runtime.call("routine.create", {
  in: space,
  text,
  agent,
  schedule: { kind: "daily", time, timezone },
});
```

`/every <HH:MM> <message>` makes a daily routine for the agent answering the space, in this
machine's timezone; `/routines` lists them; `/run <n>` runs one now. Timers ring while the runtime
is running: the terminal, or the server.

## Run it

```text
ana › /every 09:00 How is the launch going?
Every day at 09:00, north gets “How is the launch going?”. /routines lists it.
ana › /routines
1. How is the launch going? · asks north
   Every day at 9:00 AM (Sao Paulo time) · next Sun, Nov 8, 9:00 AM
ana › /run 1
Ran “How is the launch going?”: sent.
ana › /routines
1. How is the launch going? · asks north
   Every day at 9:00 AM (Sao Paulo time) · next Sun, Nov 8, 9:00 AM · last sent
ana › /threads
[1] 475fa9d4 · 11/8/2026, 7:48:52 AM · 2 messages · You said: Ana (via routine
"How is the launch going?"): How…
/open <n> continues one.
ana › /open 1
Ana → north › How is the launch going?
north › You said: Ana (via routine "How is the launch going?"): How is the
launch going?
Continuing 475fa9d4.
```

Offline, North's model only repeats what it read, and that shows what the routine sent: your
message, marked as the routine's. With a key, North answers it. Leave the terminal open past nine,
and the next run comes by itself.

## Check it

Nobody waits for nine o'clock in a test. `createRuntime` takes a `clock`, and Copilotz's
`manualClock` is one that moves only when told to, firing what comes due on the way, in time order.
The tests start it on Monday 2 November 2026, 8:00 UTC (`tests/start.ts`), and move it on:

```ts
const advance = async (ms: number) => {
  clock.advance(ms);
  do {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (runtime.stats().pending > 0);
};
```

`tests/routines.test.ts` makes a daily routine and an hourly one, checks the timer (`routine.fire`,
`0 9 * * *`, set as Ana), moves an hour on and finds the 9:00 run, its chat named "Morning news ·
2026-11-02" and the agent reading `Ana (via routine "Morning news")`; a day later, a new chat for
one and always the same for the other. Another pauses, runs now, resumes, archives the space (the
run is `forbidden`, and says why) and deletes; a third checks what a routine needs.
`tests/parity.test.ts` runs the same scenario, on the same clock, on Copilotz's routines (on
Copilotz's identity and spaces) and on yours, and compares the answers, the timers, the runs and
what the agents were sent. `tests/web.test.ts` and `tests/terminal.test.ts` draw the tab, the page
and `/routines`.

## Also in this chapter

- `plugins/routines/actions/update.ts`, `pause.ts`, `resume.ts`, `delete.ts`, `run.ts`: changing a
  routine sets its timer again; pausing takes it away; "Run now" records a run with who asked.
- `plugins/routines/shared/routines.ts`: the fields the Actions take, the timer's id, `arm` (the
  timer, set again as the routine's maker), and `chatTitle` (`{name} · {date}`).
- `plugins/routines/collections/routine.ts` and `run.ts`: the queries `routine.list` (a space's
  routines, oldest first) and `routine.runs` (a routine's runs, newest first); and `contract.ts`
  (the types other code imports, and `routinePath`).
- `plugins/routines/views/web/routines-tab.tsx`, `routine-page.tsx`, `when.ts`, `style.ts`, and
  `views/terminal/routines.ts`.
- `app.ts` (routines after skills), `front.ts` (`routinesWeb`) and `terminal.ts`
  (`routinesTerminal`).

`git diff lesson-8.1 lesson-8.2` shows every change.

## What you have now

Messages that go out on time, as you, to the agent you choose, each run on the record with its chat.
Time is one more caller of the same Actions. Next, the agents set routines up themselves, from a
chat: "remind me every Monday…".
