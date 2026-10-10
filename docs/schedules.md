---
title: "Schedules"
description: "Store recurring jobs as durable state, let the host decide when time passes, and react to stable due occurrences with your own plugin."
section: Operate
order: 20
status: stable
---

# Schedules

## The pain

A team wants a reminder note every weekday at 09:00 in São Paulo. A
`setInterval` in the server process seems to work until the process restarts:
the next run time is lost, a restart mid-minute runs the reminder twice, two
overlapping callbacks race each other, and an outage of an hour either silently
skips work or, with naive catch-up code, floods the application with sixty
reminders.

## The problem

Recurring work needs three contracts that a timer does not provide:

- **Durable schedule state.** The job, its cron rule, its next run time and its
  last occurrence must survive restarts and be changed safely.
- **Stable occurrences.** Each due run needs an identity, so a claim happens
  once per cron slot and a retried handler can resolve to work already recorded.
- **Host-owned time.** A CLI, a server, a platform cron trigger, a browser tab
  and a test keep time differently. The library cannot safely start a background
  clock for all of them.

The scheduler should also not interpret the job's meaning. The plugin that
scheduled the work owns what it does.

## The solution

Compose `schedulesPlugin` from `@copilotz/copilotz/schedules`. It contributes a
`scheduled_job` Collection and two Actions reached through input envelopes. It
runs **no timer**: every claim happens because the host sent an input.

### Jobs

A Scheduled Job record has a `name`, a `status` (`active`, `paused` or
`cancelled`), a `schedule`, an opaque `payload` object, optional `metadata` and
`content`, and the scheduler-owned fields `nextRunAt` (ISO string or `null`),
`nextRunAtMs` and `lastOccurrence`.

- `schedule` is currently always `{ type: "cron", expression, timezone? }`.
  Always set `timezone`, either `"UTC"` or an IANA name such as
  `"America/Sao_Paulo"`. Without it the expression follows the host process's
  local timezone, so the same job can fire at different instants on different
  machines. Stored instants such as `nextRunAt` are ISO 8601 UTC strings either
  way; that is separate from how the rule is evaluated.
- `payload` is never read by the Schedules plugin. Give it a discriminator, such
  as `type: "notes.digest"`, and match it in your own Processor. A payload
  grants no authority: anyone who can write a job can write any payload, so the
  reacting Processor validates what it accepts and never treats payload fields
  as trusted commands.

Inside an Action, use the public helpers. Each takes `{ collections, now }`, so
pass the Action `context`:

| Helper               | Behaviour                                                            |
| -------------------- | -------------------------------------------------------------------- |
| `createScheduledJob` | Validates the schedule and sets the first `nextRunAt` after `now`.   |
| `getScheduledJob`    | Returns the job by `id`, or `null`.                                  |
| `listScheduledJobs`  | Returns one page, with optional `status`, `after` and `limit`.       |
| `updateScheduledJob` | Patches fields; recomputes or clears `nextRunAt` as described below. |

`createScheduledJob` accepts status `active` or `paused`, not `cancelled`.
`updateScheduledJob({ id, patch }, context)` replaces `payload` as a whole when
that field is supplied; omitted fields stay unchanged. Replacing the schedule,
resuming a paused job, or updating an active job whose next run is already past
recomputes `nextRunAt` after `now`. Cancelling clears it. There is no delete
helper; cancel a job instead.

The create and update helpers write with fixed keys,
`scheduled_job.create:<id or name>` and `scheduled_job.update:<id>`. They do not
add the Action's `operationKey` prefix, so these keys are scoped to the whole
delivery, not to one Action invocation. Within one delivery, call each helper at
most once per key. Make independent changes to the same job through separately
admitted operations. See [Actions](./actions.md) for how write keys are scoped.

### Ticks and manual runs

The host builds inputs with two functions and passes them to `app.send`. Both
also accept `namespace`, `correlationId`, `causationId` and `deduplicationId`.

- `scheduleTick({ checkedAt?, limit? })` claims active jobs whose `nextRunAt` is
  at or before `checkedAt` (the application clock's now when omitted). `limit`
  is 1–1000, default 10, and caps the claims in this tick, earliest first. It
  does not bound the lookup: the tick still reads every active job before
  filtering.
- `runScheduledJobNow({ id, scheduledFor? })` claims one **manual** occurrence
  for `scheduledFor` (default now). It never moves `nextRunAt`. It works on an
  `active` or `paused` job and fails on a `cancelled` one.

Every claim appends one durable `scheduled_job.due` Event. Its `data.record` is
the job after the claim: `record.payload` is your opaque payload and
`record.lastOccurrence` is `{ id, mode, scheduledFor }`. Scheduled occurrence
IDs are `<jobId>:<epoch ms>`; manual ones are `<jobId>:manual:<epoch ms>`.

When claiming one job fails, the tick records that failure and moves on to the
next job. Invalid tick input, a failure while reading the jobs, or a failure in
other work can still reject the operation. The tick's
`copilotz.schedules.tick.completed` Event carries a `ScheduledJobTickResult` in
`data.output`: counts plus `jobs[]` items with status `claimed`, `skipped`
(another tick won, or the job stopped being due) or `failed` with an `error`. A
fulfilled `done` therefore does not mean every job was claimed; inspect
`failed`. `claimed` means the due Event was committed, not that your downstream
work succeeded; that is your Processor's own delivery.

### Occurrence semantics

- **Atomic claims.** A scheduled claim succeeds only while the job is still
  `active` and its `nextRunAt` equals the candidate's slot. The claim then moves
  `nextRunAt` to the next run after `checkedAt`. A second tick cannot claim the
  same slot.
- **Missed ticks coalesce.** Time passes while no clock runs, but nothing is
  claimed until a tick arrives. A late tick claims one occurrence, for the
  stored `nextRunAt`, and schedules the next run after the check time. There is
  no backfill of every missed slot.
- **Pause and cancel.** Ticks ignore `paused` and `cancelled` jobs. Resuming
  recomputes `nextRunAt` from now, so slots missed while paused are not
  replayed. Cancelling clears `nextRunAt`.
- **Manual runs are separate claims.** Two separately admitted manual requests
  for the same `scheduledFor` each emit a due Event with the same occurrence ID.
  For a safe retry, resend the complete request with the same `correlationId`
  and `deduplicationId`; admission then returns the original operation.
- **Handlers run at least once.** Key the work by the occurrence ID, as in the
  example below. External services need their own idempotency key.

### Worked example

Before you start, build `notes-plugin.ts` and `digest-plugin.ts` from
[Chapter 19: Schedule Recurring Work](./getting-started/part-5-operate-and-scale/19-schedule-recurring-work.md).
This probe reuses them unchanged. You also need Deno 2.9+, or Node 24+ with
`@copilotz/copilotz@^0.86.3` and its PGlite dependency installed as shown in the
[Quickstart](./quickstart.md).

The probe adds one small pause Action. It then sends ticks with explicit check
times against the private in-memory database, so nothing waits for a real
minute.

Create `schedule-probe.ts`:

```ts
// Runtime factory, definitions and typed contexts.
import {
  createCopilotz,
  defineAction,
  definePlugin,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
import type {
  ActionCallers,
  ActionContext,
  ApplicationOutput,
  ProcessorContext,
} from "@copilotz/copilotz";
// Schedule helpers, input envelopes and result types.
import {
  runScheduledJobNow,
  scheduleTick,
  updateScheduledJob,
} from "@copilotz/copilotz/schedules";
import type {
  ScheduledJob,
  ScheduledJobTickResult,
} from "@copilotz/copilotz/schedules";
// Chapter 19's digest job and its plugin.
import { DIGEST_JOB_ID, digestPlugin } from "./digest-plugin.ts";

// Pauses the digest job through the Collection-owned update helper.
const pauseDigest = defineAction({
  id: "notes.digest.pause",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const,
  async execute(
    _input: Record<string, never>,
    context: ActionContext,
  ): Promise<ScheduledJob> {
    return await updateScheduledJob(
      { id: DIGEST_JOB_ID, patch: { status: "paused" } },
      context,
    );
  },
});

// Turns a pause request into one Action call per delivery.
const pauseOnRequest = defineProcessor<
  ProcessorContext<
    ProcessorContext["resources"],
    ProcessorContext["adapters"],
    ActionCallers<{ pauseDigest: typeof pauseDigest }>
  >
>({
  id: "notes.digest.pause-on-request",
  on: [{ eventType: "notes.digest.pause.requested" }],
  async handle(event, context) {
    if (!event.durable) return;
    await context.actions.pauseDigest({}, { operationKey: "pause-request" });
  },
});

const probePlugin = definePlugin({
  id: "@team-notes/schedule-probe",
  version: "1.0.0",
  plugins: [digestPlugin],
  actions: { pauseDigest },
  processors: { pauseOnRequest },
});

// Sends one input, drains outputs alongside settlement, and returns the tick
// result (if any) and the next run times seen on due Events.
type App = Awaited<ReturnType<typeof createCopilotz>>;
type DueData = { record: ScheduledJob };
type TickData = { output: ScheduledJobTickResult };

async function run(app: App, input: Parameters<App["send"]>[0]) {
  const handle = await app.send(input);
  let tick: ScheduledJobTickResult | undefined;
  const due: string[] = [];
  const outputs: ReadableStream<ApplicationOutput> = handle.outputs;
  const drain = (async () => {
    for await (const output of outputs) {
      if (isStreamOutput(output)) {
        await output.payload.cancel();
        continue;
      }
      if (!output.durable) continue;
      if (output.type === "scheduled_job.due") {
        const { record } = output.data as DueData;
        due.push(`${record.lastOccurrence?.id} next=${record.nextRunAt}`);
      } else if (output.type === "copilotz.schedules.tick.completed") {
        tick = (output.data as TickData).output;
      }
    }
  })();
  const [drained, settled] = await Promise.allSettled([drain, handle.done]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;
  return { tick, due };
}

// No database option: the private in-memory default.
const app = await createCopilotz({
  namespace: "team-notes",
  plugins: [probePlugin],
});
try {
  await run(app, { type: "notes.digest.configure.requested", payload: {} });
  // Ten minutes late: one coalesced claim, next run after the check time.
  const late = new Date(Date.now() + 10 * 60_000).toISOString();
  const first = await run(app, scheduleTick({ checkedAt: late }));
  console.log("late tick", first.tick?.claimed, first.due);
  // The same check time again: the slot was already claimed.
  const second = await run(app, scheduleTick({ checkedAt: late }));
  console.log("repeat tick", second.tick?.claimed);
  // Paused: ticks skip it, manual runs still claim and keep nextRunAt.
  await run(app, { type: "notes.digest.pause.requested", payload: {} });
  const paused = await run(app, scheduleTick({ checkedAt: late }));
  console.log("paused tick", paused.tick?.claimed);
  const manual = await run(
    app,
    runScheduledJobNow({
      id: DIGEST_JOB_ID,
      scheduledFor: "2026-10-06T09:00:00Z",
    }),
  );
  console.log("paused manual", manual.due);
} finally {
  await app.close();
}
```

Run `deno run -A schedule-probe.ts` or `node schedule-probe.ts`. Expect
`late tick 1` with one `notes-digest:<ms>` occurrence whose `next=` is after the
late check time, `repeat tick 0`, `paused tick 0`, and one
`notes-digest:manual:1791277200000` occurrence whose `next=` equals the late
tick's. The digest Processor saves one reminder per claimed occurrence.

### Core scheduled messages (optional)

`coreSchedulesPlugin` from `@copilotz/copilotz/schedules/core` connects generic
jobs to Core conversations. It already includes its Core and Schedules plugin
dependencies. Add agent resources and a model connection only if you want agents
to reply to the scheduled messages. Its payload type is
`CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE` (`copilotz.core.scheduled-message`), and
`scheduledMessageJob` builds a typed job input. On each due occurrence it sends
a public message to the job's recipients.

It also contributes the `scheduled_jobs` Tool (create, get, list, update, pause,
resume, cancel, run_now). An agent can use it only when granted, by appending
`"scheduled_jobs"` to that agent's `capabilities.tools`. Treat the grant as
letting the model create recurring messages on someone's behalf: only grant it
to agents serving trusted actors, and authorize who may reach those agents. The
`caller` recipient requires trusted Core Tool provenance.

For Space-scoped jobs only, dispatch reads the live job again before sending and
skips the job if its Space ownership, target thread or active status changed.
Jobs without a Space do not get these checks. Do not read the generic rule
"manual runs work on paused jobs" as a promise that a paused Core job still
delivers a message; check the dispatch result.

## What this unlocks

- Recurring work that survives restarts, with one claim per cron slot.
- Any host clock: a serial CLI loop, a server timer, a platform cron trigger
  calling an HTTP route, or a test with fixed `checkedAt` values.
- Retry-safe handlers keyed by stable occurrence IDs.
- Plugin-owned scheduled behaviour behind an opaque, discriminated payload.

## Next steps

- Tutorial:
  [Chapter 19: Schedule Recurring Work](./getting-started/part-5-operate-and-scale/19-schedule-recurring-work.md)
  builds the digest plugin and a serial host clock.
- [Actions](./actions.md) explains operation keys and retry identity.
- [Events, Deliveries, and Recovery](./events-deliveries-recovery.md) covers how
  due Events are delivered and retried.
- [Agent capabilities](./agent-capabilities.md) covers Tool grants for
  `scheduled_jobs`.
