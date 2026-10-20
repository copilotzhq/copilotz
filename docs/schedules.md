---
title: "Schedules"
description: "Store recurring jobs as durable state, wake from the database owner’s durable alarm, and react to stable due occurrences with your own plugin."
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
- **One durable owner wake.** Schedule changes and the next wake commit
  together. Restart or takeover re-arms the earliest pending deadline. An idle
  owner has no scheduled wake and produces no clock events.

The scheduler should also not interpret the job's meaning. The plugin that
scheduled the work owns what it does.

## The solution

Compose `schedulesPlugin` from `@copilotz/copilotz/schedules`. It contributes a
`scheduled_job` Collection with an owner-alarm declaration and a manual-run
Action. The owner invokes the Collection’s `due` command at the persisted time;
applications do not send periodic clock inputs.

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

### Automatic occurrences and manual runs

Active jobs register their exact `nextRunAt` in the owner's indexed deadline
queue. A due wake reads only due entries, invokes the ordinary `due` Collection
command, and updates the next deadline in the same transaction as the resulting
`scheduled_job.due` Event. Pausing, cancelling or deleting a job removes its
pending scheduled deadline atomically.

Every due Event contains `data.record`, the updated job. Its `lastOccurrence` is
`{ id, mode, scheduledFor }`. Scheduled identity is `<job-id>:<due-time-ms>`;
`scheduledFor` remains the original due instant even after downtime. The next
cron slot is calculated strictly after the owner's current check time. Missed
intermediate slots are skipped rather than emitted as a catch-up burst.

`runScheduledJobNow({ id, scheduledFor? })` builds a manual input envelope for
`app.send`. It accepts `namespace`, `correlationId`, `causationId` and
`deduplicationId`. A manual run works on an active or paused job, rejects a
cancelled job, and does not change the next scheduled time. Manual identity is
`<job-id>:manual:<scheduled-for-ms>`. Retry the complete same input identity to
reuse its recorded operation; separately admitted manual requests are separate
requests even if they have the same occurrence identity.

### Reacting to an occurrence

Install a durable Processor for `scheduled_job.due`. Validate the payload's
discriminator and fields before executing it. The Schedules plugin keeps that
payload opaque and grants it no additional authority. Use the occurrence ID as a
stable key for the resulting work; external effects also require the external
provider's idempotency or reconciliation contract.

The optional `content` belongs to the Scheduled Job's domain record. Ordinary
content ownership and deletion apply. A job's due Event keeps plain references
and does not create a second retention owner.

### Protected domain delegation

Only an actual Scheduled Job owner-alarm occurrence supplies protected Action
source `ingress` with `kind: "scheduled-occurrence"`, `scheduleId`,
`occurrenceId`, `scheduledFor`, and `scheduleVersion`. The owner atomically
binds this evidence to the exact due Event/body and selected durable deadline
revision. Direct Collection commands, manual runs, metadata flags and generic
owner Events do not mint it. A stale deadline cannot mint proof or replace a
newly scheduled wake, including when an update retains the same due time.

Import `scheduledJobDelegationDigest` from `/schedules` to bind a domain-owned
delegation to `{ databaseSchema, namespace, record }`. It returns `sha256:<hex>`
over canonical, recursively key-sorted JSON with the domain tag
`copilotz.scheduled-job.delegation.v1`. The record projection includes `id`,
`spaceId`, `status`, `schedule`, `payload`, `content` and `metadata`; omitted
`spaceId` and `content` become null. Array order is retained. Unsupported
values, accessors, non-finite numbers and values beyond the bound are refused.

An owner policy must separately retain the original authorized delegation and
recheck its current permissions, active state, scope and exact digest before
using a protected credential. An occurrence proves execution timing, not an
end-user identity or permission. Excluded `name`, `createdAt`, `updatedAt`,
`nextRunAt`, `nextRunAtMs` and `lastOccurrence` must never serve as
authorization inputs. Changing payload, creator metadata, Space, schedule or
status cannot expand a retained delegation; revoked or cancelled delegation
remains denied.

### Owner lifecycle

Each database-schema owner has one persisted earliest-next-wake covering job
occurrences, delivery availability, retry backoff, remote leases, reconciliation
and registered content deadlines. On startup it restores retained deadlines,
recovers old attempts, then activates and re-arms. It never creates a global
fan-out clock Event or scans all active jobs on each wake.

The default server adapter uses one cancellable timer for the persisted wake. An
engine host can provide `alarmScheduler` with `schedule(callback, delayMs)` and
`cancel(handle)` to map the same owner lifecycle to its platform. The injected
`now` clock and alarm scheduler must describe the same timeline. Shutdown drains
owner wake handlers and delivery callbacks before closing persistence.

### Updating older applications

Remove periodic schedule-input senders and their namespace fan-out. Install the
Schedules plugin in the owner runtime and keep its owner alive, or map the
owner's alarm scheduler to the deployment platform. Job records, cron rules,
manual-run input identities and `scheduled_job.due` consumers remain valid.
There is one runtime and one alarm path, with no legacy tick mode.

For messages and Agent routing, compose `coreSchedulesPlugin` from
`@copilotz/copilotz/schedules/core`; it consumes typed due payloads without
changing the base plugin's scheduling rules.

### Current-policy refusal

A protected Collection policy runs for the actual owner's selected alarm read
and declared command. A permanent current-policy denial consumes only that
selected deadline key/revision. It creates no due Event and does not mutate the
job or stop unrelated alarms. A replacement deadline revision survives. A job
left active after refusal requires an explicit authorized resume/rearm; its
record alone does not cause repeated unauthorized wakes. Database and provider
failures remain retryable work rather than being consumed as denials.

The existing process-local diagnostic sink receives `owner_alarm_refused` after
conditional deadline completion, with only schema, namespace, timestamp and the
fixed `forbidden` status. It contains no record ID, payload or callback error.
