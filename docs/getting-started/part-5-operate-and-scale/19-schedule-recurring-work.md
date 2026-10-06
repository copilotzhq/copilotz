---
title: "Chapter 19: Schedule Recurring Work"
description: "Turn host clock ticks into durable scheduled occurrences: a digest plugin owns a stable Scheduled Job and saves one reminder note per occurrence, while the host decides when time passes."
section: Getting Started
order: 190
status: stable
---

# Chapter 19: Schedule Recurring Work

> Part 5 — Operate and Scale · Track: R · Requires: Chapter 7 · Needs: Deno 2.9+
> or Node 24+ (no credential)

## The pain

Notes saves a note only when someone sends a capture request. The team now wants
a recurring digest reminder: a note that appears on a fixed schedule, without
anybody typing it.

The obvious fix is a `setInterval` in an entrypoint that calls `app.send` every
minute. It works until the process restarts. Then nothing remembers when the
last reminder ran, a restart in the middle of a minute saves the reminder twice,
and two overlapping callbacks can race each other. The schedule itself, "every
minute in UTC", lives only in that one script's code.

## The problem

Recurring work mixes two different things:

- **The schedule** is application state. Which job exists, its cron expression,
  when it next runs and which occurrence ran last must survive restarts. Each
  occurrence needs a stable identity, so that a handler that runs again for it
  can resolve to the work already recorded.
- **Time passing** is a host fact. Something outside the application has to wake
  up and say "it is now 09:00". A library cannot own that safely: a browser tab,
  a Worker, a CLI and a long-lived server each keep time differently, and some
  should never run a background timer at all.

The work that a due job does also belongs to the plugin that scheduled it. The
schedule store should keep the job's data without interpreting it.

## The solution

Compose the published **Schedules plugin**, `schedulesPlugin` from
`@copilotz/copilotz/schedules`. It contributes a `scheduled_job` Collection and
two input envelopes. It runs no timer:

- `scheduleTick({ checkedAt?, limit? })` builds an input that claims active jobs
  whose next run time is at or before `checkedAt` (the current time when
  omitted), at most `limit` of them (default 10). `limit` bounds the claims, not
  the work of finding them: the tick still reads every active job.
- `runScheduledJobNow({ id, scheduledFor? })` builds an input that runs one job
  now as a **manual** occurrence, without changing its next scheduled time.

Both accept `correlationId` and `deduplicationId`, and you pass the result to
`app.send`. Each claimed occurrence appends one durable `scheduled_job.due`
Event. Its `data.record` is the job record after the claim: `payload` is the
job's opaque data and `lastOccurrence` is `{ id, mode, scheduledFor }` for the
occurrence that just became due.

The Schedules plugin never reads `payload`. Your plugin gives it a
discriminator, here `type: "notes.digest"`, and a Processor that matches that
discriminator does the work. The payload grants no authority: whoever can write
a job can write any payload, so the Processor checks what it accepts, and the
host still chooses the namespace it runs in.

What makes repeats safe differs by path:

- **Scheduled claims.** A tick claims an occurrence only while it is still the
  job's expected next run time, and the claim moves that time forward from the
  check time. A second tick therefore cannot claim the same cron slot again; it
  reports the job as skipped.
- **Manual runs.** Each `runScheduledJobNow` request is its own claim. Two
  separately admitted requests for the same `scheduledFor` both append a due
  Event, even though they carry the same occurrence ID. A retry is safe only
  when it resends the complete request with the same `correlationId` and
  `deduplicationId`, so admission returns the original operation.
- **Handlers.** Durable deliveries run at least once. The digest Processor keys
  its Action call by the occurrence ID, so a retried delivery reuses the
  recorded note. A call to an outside service, such as email, needs that
  service's own idempotency key.

Missed minutes are **coalesced**. Scheduled times keep passing while no clock
runs, but nothing is claimed or processed until a tick arrives. The next tick
then claims one occurrence, for the job's stored next run time, and schedules
the following run after the check time. There is no backfill of every missed
minute.

### Create `digest-plugin.ts`

`digest-plugin.ts` is a **definition module**. It depends on `notesPlugin` and
`schedulesPlugin`, reads no environment and starts nothing when imported. It
declares:

- `notes.digest.configure`, an Action that creates the stable `notes-digest` job
  only when it is missing. Restarts never reset its state or replace its cron
  expression.
- `notes.digest.setup`, a Processor that calls that Action for each
  `notes.digest.configure.requested` input.
- `notes.digest.remind`, a Processor that reacts to due `notes.digest` jobs and
  saves one reminder note through the existing `notes.save` Action.

The reminder is honest about what it is: a note saying a digest is due for that
occurrence, not a summary of other notes.

```ts
// Helpers that declare the Action, the Processors and the Plugin.
import {
  defineAction,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Context and Action-caller types for typed handlers.
import type {
  ActionCallers,
  ActionContext,
  ProcessorContext,
} from "@copilotz/copilotz";
// The published Schedules plugin, its Collection helpers and record types.
import {
  createScheduledJob,
  getScheduledJob,
  schedulesPlugin,
} from "@copilotz/copilotz/schedules";
import type {
  ScheduledJob,
  ScheduledJobOccurrenceRef,
} from "@copilotz/copilotz/schedules";
// The Notes package this plugin builds on, and its reusable save Action.
import { notesPlugin, saveNote } from "./notes-plugin.ts";

// Stable ID of the one digest job. Keep it once the job is stored.
export const DIGEST_JOB_ID = "notes-digest";

// The opaque payload stored on the job. Only this plugin interprets it; the
// `type` discriminator selects which Processor reacts.
export type DigestPayload = Readonly<{ type: "notes.digest"; version: 1 }>;

// Creates the digest job if it does not exist yet, and otherwise returns the
// stored job unchanged, so restarts keep its next run time and last occurrence.
export const configureDigest = defineAction({
  // Stable identity; lifecycle Events are `notes.digest.configure.*`.
  id: "notes.digest.configure",
  // No caller options: the schedule is this plugin's decision.
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const,
  async execute(
    _input: Record<string, never>,
    context: ActionContext,
  ): Promise<ScheduledJob<DigestPayload>> {
    // Read first, so an existing job is never reset or rescheduled.
    const existing = await getScheduledJob<DigestPayload>(
      { id: DIGEST_JOB_ID },
      context,
    );
    if (existing) return existing;
    // The helper writes through the `scheduled_job` Collection with its own
    // stable key, `scheduled_job.create:notes-digest`. This Action makes that
    // write once per call, so the key never covers two different creates.
    return await createScheduledJob<DigestPayload>({
      id: DIGEST_JOB_ID,
      name: "Notes digest reminder",
      // Every minute, evaluated in UTC, so the example shows several
      // occurrences quickly. Choose a real cadence, such as "0 9 * * 1-5".
      schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      payload: { type: "notes.digest", version: 1 },
    }, context);
  },
});

// The Action callers the two Processors use, as the third type parameter.
type DigestContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<
    { configureDigest: typeof configureDigest; saveNote: typeof saveNote }
  >
>;

// Turns a host's configure request into one `notes.digest.configure` call.
export const setupDigest = defineProcessor<DigestContext>({
  id: "notes.digest.setup",
  on: [{ eventType: "notes.digest.configure.requested" }],
  async handle(event, context) {
    // Configure only from stored requests.
    if (!event.durable) return;
    // One call per delivery; a retried delivery reuses the recorded result.
    await context.actions.configureDigest({}, {
      operationKey: "configure-request",
    });
  },
});

// Returns the due occurrence when the Event describes a job this plugin
// accepts: a version 1 digest payload and a well-formed last occurrence.
// Anything else is ignored. This is the plugin's own policy check; the
// payload proves nothing about who wrote the job.
function digestOccurrence(
  data: unknown,
): ScheduledJobOccurrenceRef | undefined {
  const record = (data as { record?: Partial<ScheduledJob> } | null)?.record;
  const payload = record?.payload;
  if (payload?.type !== "notes.digest" || payload.version !== 1) {
    return undefined;
  }
  const occurrence = record?.lastOccurrence;
  if (
    !occurrence ||
    typeof occurrence.id !== "string" || !occurrence.id ||
    (occurrence.mode !== "scheduled" && occurrence.mode !== "manual") ||
    typeof occurrence.scheduledFor !== "string" ||
    Number.isNaN(Date.parse(occurrence.scheduledFor))
  ) {
    return undefined;
  }
  return occurrence;
}

// Saves one reminder note for each due digest occurrence.
export const remindDigest = defineProcessor<DigestContext>({
  id: "notes.digest.remind",
  // Match only due jobs whose opaque payload carries this plugin's type.
  on: [{
    eventType: "scheduled_job.due",
    data: { record: { payload: { type: "notes.digest" } } },
  }],
  async handle(event, context) {
    // Act only on the stored due Event, and validate the record before using
    // it.
    if (!event.durable) return;
    const occurrence = digestOccurrence(event.data);
    if (!occurrence) return;
    // `notes.save` keeps its own Collection key prefix. This key, derived from
    // the occurrence, makes a retried delivery reuse the saved reminder.
    await context.actions.saveNote(
      {
        text:
          `Digest reminder (${occurrence.mode}) for ${occurrence.scheduledFor}`,
      },
      { operationKey: `digest:${occurrence.id}` },
    );
  },
});

// The digest package. Depending on both plugins registers each of them once,
// even when the application also lists `notesPlugin` itself.
export const digestPlugin = definePlugin({
  id: "@team-notes/digest",
  version: "1.0.0",
  plugins: [notesPlugin, schedulesPlugin],
  actions: { configureDigest },
  processors: { setupDigest, remindDigest },
});
```

The due Processor matches on `data.record.payload.type`, not on the bare
payload: the Event describes the job record, and the occurrence is its
`lastOccurrence`.

### Edit `composition.ts`

Two changes to Chapter 7's file: insert the `digestPlugin` import and append it
to `runtimePlugins`. `namespace` and the `file://./data` database stay. The
complete updated file:

```ts
// The database options type, so a mistyped option fails type-checking here
// rather than at startup.
import type { CopilotzOminipgOptions } from "@copilotz/copilotz";
// The reusable Notes package. The application composes it; it does not copy it.
import { notesPlugin } from "./notes-plugin.ts";
// The digest reminder package, which depends on Notes and Schedules.
import { digestPlugin } from "./digest-plugin.ts";

// Tenant namespace recorded on every Event and record this application owns.
// It is the application's choice, so the plugin does not declare one. Keep it
// unchanged between runs: operations and records are looked up within it.
export const namespace = "team-notes";

// The database that the Notes host entrypoints open: a local PGlite database
// stored in the `data` directory. Unlike the in-memory default, it survives
// `close()` and process exit, so a later process finds the same notes, Events
// and operations.
export const database: CopilotzOminipgOptions = { url: "file://./data" };

// Runtime plugins this application composes, in order. Later chapters append to
// this list, so each Notes entrypoint gains new behaviour without dropping it.
export const runtimePlugins = [notesPlugin, digestPlugin];
```

The digest only ever passes `{ text }` to `notes.save`, so it keeps working if
you added optional fields to notes in Chapter 18.

### Create `clock.ts`

`clock.ts` is an **entrypoint**: the host clock. It opens the application with
the shared composition, sends the configure request, and then runs one of two
modes:

- `manual <scheduledFor>` sends one `runScheduledJobNow` request and exits. The
  same `scheduledFor` always produces the same complete request, including
  `correlationId` and `deduplicationId`, so rerunning the command returns the
  original operation instead of claiming again.
- `timer [seconds]` is the opt-in real clock. It runs one serial loop: send a
  `scheduleTick`, wait for it to settle, then wait the interval. Ticks never
  overlap, unlike an `async` callback passed to `setInterval`.

A tick operation can complete while individual jobs failed: the
`copilotz.schedules.tick` Action reports them in its result instead of failing
the whole operation. `clock.ts` reads that result from
`copilotz.schedules.tick.completed`, prints each failed job, and stops with an
error once the operation has settled. A fulfilled `done` alone does not mean
every job succeeded.

`SIGINT` and `SIGTERM` listeners are installed as soon as the application
exists. A signal during configure, a manual run or a tick lets that operation
settle and starts nothing new; a signal during the wait ends it at once. The
listeners are removed and the application is closed in `finally`, on every path.

```ts
// Runtime factory and the stream guard.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type { ApplicationOutput } from "@copilotz/copilotz";
// Typed Schedules input envelopes and the tick result type.
import { runScheduledJobNow, scheduleTick } from "@copilotz/copilotz/schedules";
import type { ScheduledJobTickResult } from "@copilotz/copilotz/schedules";
// The shared host choices, now including the digest plugin.
import { database, namespace, runtimePlugins } from "./composition.ts";
import { DIGEST_JOB_ID } from "./digest-plugin.ts";
// Mode and arguments come from the command line; signals stop the clock.
import process, { argv } from "node:process";

// The largest delay setTimeout honours; larger values fire almost at once.
const MAX_DELAY_MS = 2_147_483_647;

// Validate arguments before opening the database.
const [mode, arg] = [argv[2], argv[3]];
if (mode !== "manual" && mode !== "timer") {
  throw new Error(
    "Usage: clock.ts manual <scheduledFor ISO time> | clock.ts timer [seconds]",
  );
}
if (mode === "manual" && !(arg && !Number.isNaN(Date.parse(arg)))) {
  throw new Error("Pass the occurrence time, such as 2026-10-06T09:00:00Z.");
}
const intervalMs = mode === "timer" ? Number(arg ?? 60) * 1000 : 0;
if (
  mode === "timer" &&
  !(Number.isFinite(intervalMs) && intervalMs >= 1000 &&
    intervalMs <= MAX_DELAY_MS)
) {
  throw new Error("The interval must be between 1 and 2147483 seconds.");
}

// Reads one field of an object, or nothing for other values.
function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

// Prints only the facts this chapter checks, not whole payloads, and returns
// the number of jobs a tick reported as failed.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<number> {
  let failed = 0;
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      continue;
    }
    if (!output.durable) continue;
    const record = field(output.data, "record");
    if (output.type === "scheduled_job.due") {
      const occurrence = field(record, "lastOccurrence");
      console.log(
        `event scheduled_job.due occurrence=${field(occurrence, "id")}`,
        `next=${field(record, "nextRunAt")}`,
      );
    } else if (output.type === "note.created") {
      console.log(
        `event note.created note=${field(record, "id")}`,
        `text=${JSON.stringify(field(record, "text"))}`,
      );
    } else if (output.type === "scheduled_job.created") {
      console.log(`event scheduled_job.created job=${field(record, "id")}`);
    } else if (output.type === "copilotz.schedules.tick.completed") {
      // The tick's own result: claimed, skipped and failed jobs.
      const result = field(output.data, "output") as ScheduledJobTickResult;
      console.log(
        `tick claimed=${result.claimed} skipped=${result.skipped}`,
        `failed=${result.failed}`,
      );
      for (const job of result.jobs) {
        if (job.status === "failed") {
          console.error(`failed job ${job.jobId}: ${job.error}`);
        }
      }
      failed += result.failed;
    }
  }
  return failed;
}

const app = await createCopilotz({
  namespace,
  database,
  plugins: runtimePlugins,
});

// Stop requests: finish the current operation, start nothing new, and end a
// pending wait immediately.
let stopping = false;
let wake: (() => void) | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log("stopping after the current operation");
  wake?.();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Waits up to `ms`, or until a stop request arrives.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wake = finish;
  });
}

// Sends one input, drains its outputs while waiting for settlement, then fails
// if a tick reported failed jobs.
async function run(
  input: Parameters<typeof app.send>[0],
): Promise<string> {
  const handle = await app.send(input);
  const [failed] = await Promise.all([
    printOutputs(handle.outputs),
    handle.done,
  ]);
  if (failed > 0) {
    throw new Error(
      `Operation ${handle.operationId}: ${failed} job(s) failed.`,
    );
  }
  return handle.operationId;
}

try {
  // Create the job if it is missing. An existing job is left as stored.
  await run({ type: "notes.digest.configure.requested", payload: {} });

  if (mode === "manual" && !stopping) {
    // One complete identity per occurrence time: rerunning resends this exact
    // request, and admission returns the original operation.
    const scheduledFor = new Date(arg!).toISOString();
    const identity = `notes-digest-manual:${scheduledFor}`;
    const operationId = await run(runScheduledJobNow({
      id: DIGEST_JOB_ID,
      scheduledFor,
      correlationId: identity,
      deduplicationId: identity,
    }));
    console.log(`manual occurrence ${scheduledFor}: operation ${operationId}`);
  } else if (mode === "timer") {
    console.log(`ticking every ${intervalMs / 1000}s; Ctrl+C stops`);
    // One serial loop: each tick settles before the wait for the next begins.
    while (!stopping) {
      // The current time is the check time.
      await run(scheduleTick());
      if (!stopping) await delay(intervalMs);
    }
  }
} finally {
  // Remove the listeners and release the database on every path.
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await app.close();
}
```

The job, its next run time and its occurrences are stored in `./data` and
survive `close()`. The clock does not. Scheduled times keep passing while no
clock runs, but no occurrence is claimed or processed until the next tick, and
that tick claims only when the stored next run time is at or before its check
time.

## Check it works

Run the commands one after another from the project directory, with one runtime.
Use the deterministic manual mode; no command waits for a real minute.

**Deno:**

```sh
deno run -A clock.ts manual 2026-10-06T09:00:00Z
deno run -A clock.ts manual 2026-10-06T09:00:00Z
deno run -A clock.ts manual 2026-10-06T09:01:00Z
```

**Node 24+:**

```sh
node clock.ts manual 2026-10-06T09:00:00Z
node clock.ts manual 2026-10-06T09:00:00Z
node clock.ts manual 2026-10-06T09:01:00Z
```

The first command prints something like this. The occurrence ID is
`notes-digest:manual:` followed by the occurrence time in milliseconds; other
IDs and the `next=` time differ:

```text
event scheduled_job.created job=notes-digest
event scheduled_job.due occurrence=notes-digest:manual:1791277200000 next=2026-10-06T14:33:00.000Z
event note.created note=5b91… text="Digest reminder (manual) for 2026-10-06T09:00:00.000Z"
manual occurrence 2026-10-06T09:00:00.000Z: operation 3f6c…
```

Check these facts:

- The first run prints `scheduled_job.created` once. Later runs print no
  `scheduled_job.created` line: configure found the stored job.
- The first run prints exactly one `scheduled_job.due` and one `note.created`.
- The second run resends the identical complete request. It prints the same
  operation ID and no new `scheduled_job.due` or `note.created`: admission
  returned the original operation.
- The third run, a new occurrence time, prints one new `scheduled_job.due` and
  one new reminder.
- `next=` is unchanged by manual runs: they never move the scheduled time.

To see the real clock, run `deno run -A clock.ts timer 15` or
`node clock.ts timer 15`. Each tick prints a `tick claimed=… skipped=… failed=0`
line. Within about a minute one tick claims a `scheduled` occurrence and saves
one reminder; later ticks before the next run time claim nothing. Press Ctrl+C:
the process lets a tick in flight settle, or ends the wait at once, then closes.

## What this unlocks

- Recurring work is durable state: the job, its next run time and every
  occurrence survive restarts in the Chapter 7 database.
- Each occurrence has a stable ID. Handlers key their work by it, so a retried
  delivery reuses recorded results, and a cron slot cannot be claimed twice.
- The host owns time. A CLI, a server, a platform cron trigger or a test can
  each drive the same plugin with `scheduleTick` or `runScheduledJobNow`, and
  reports per-job tick failures as it chooses.
- Any plugin can schedule its own work behind an opaque, discriminated payload
  without the Schedules plugin knowing what it means.

## Next steps

- Next (optional, agent harness, requires Chapter 17):
  [Chapter 20: Measure Usage](./20-measure-usage.md) records model and tool
  usage. Runtime-only readers can skip it.
- Runtime only: [Chapter 21: Deploy and Scale](./21-deploy-and-scale.md) moves
  Notes to a shared database with separate gateway and worker roles.
- Reference: [Schedules](../../schedules.md) covers cron rules, pausing,
  updating, tick limits and coalescing.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains how due Events are delivered and retried.
