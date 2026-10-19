---
title: "Chapter 19: Schedule Recurring Work"
description: "Store durable recurring jobs and let the database owner's next-wake alarm produce stable occurrences."
section: Getting Started
order: 190
status: stable
---

# Chapter 19: Schedule Recurring Work

Compose `schedulesPlugin` from `@copilotz/copilotz/schedules` in your
application. The database owner runs active jobs at their persisted deadline.
Your host does not send clock Events or fan out a recurring input across
namespaces.

## Create a recurring job

Inside an Action or Processor, pass its `{ collections, now }` context to the
Scheduled Job helper:

```ts
import { createScheduledJob } from "@copilotz/copilotz/schedules";

await createScheduledJob({
  id: "weekly-digest",
  name: "Weekly digest",
  schedule: { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
  payload: { type: "notes.digest" },
}, context);
```

The helper validates the cron rule and stores the first run strictly after now.
Specify an explicit timezone for portable schedule interpretation. Use
`getScheduledJob`, `listScheduledJobs` and `updateScheduledJob` to read or
change the record through its normal Collection contract.

## React to due work

A durable Processor subscribes to `scheduled_job.due`. Its `event.data.record`
contains the updated job, including the opaque payload and `lastOccurrence`.
Validate the payload before acting. Key downstream work by
`record.lastOccurrence.id`; durable execution can retry a delivery, and an
external service needs its own effect idempotency contract.

A scheduled occurrence has identity `<job-id>:<original-due-time-ms>`. The due
command checks the job is active and that its expected next time is unchanged,
then appends the Event and advances both the job and its alarm atomically. A
competing callback cannot create a second occurrence for the same slot.

## Downtime and misfires

Suppose a job was due at 09:00 and its owner resumes at 09:17. The owner emits
one occurrence for the original 09:00 time and computes the next cron slot after
09:17. It skips the intermediate missed slots. Restart does not restart delivery
backoff or discard pending work, and takeover fences the old owner before the
new owner activates.

The owner reads the indexed due queue. It does not enumerate every active job
for every wake, and an empty owner has no timer or clock Event traffic.

## Pause, resume and run manually

Pausing removes the scheduled deadline. Resuming recomputes a future cron slot;
cancelling clears the next run. These changes commit with their alarm updates.

For an explicit manual run:

```ts
import { runScheduledJobNow } from "@copilotz/copilotz/schedules";

const input = runScheduledJobNow({
  namespace: "workspace",
  id: "weekly-digest",
  scheduledFor: "2026-01-05T09:00:00.000Z",
  correlationId: "manual-digest-1",
  deduplicationId: "manual-digest-1",
});
const handle = await app.send(input);
await handle.done;
```

Manual runs work while a job is paused and leave its scheduled time unchanged.
Cancelled jobs reject manual runs. Retrying the same full input identity returns
its recorded operation. Two separately admitted requests remain separate manual
runs, even if their semantic occurrence IDs match.

## Host lifecycle

Keep the owner runtime alive for the jobs it owns. Its one alarm also covers
retries, remote leases, reconciliation and content retention. Platform adapters
can supply an engine `alarmScheduler` with `schedule` and `cancel`;
deterministic tests can inject both this scheduler and the corresponding `now`
clock.

Shutdown drains alarm handlers and delivery settlement before persistence
closes. No application-level timer loop is needed. See
[Schedules](../../schedules.md) for the complete job and occurrence contract,
including migration from older periodic-input integrations.
