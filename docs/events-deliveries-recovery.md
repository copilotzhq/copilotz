---
title: "Events, Deliveries, and Recovery"
description: "How an operation, its immutable Events, its at-least-once deliveries and its Action calls relate, and how to resend, observe, cancel and recover them without duplicating work."
section: Runtime
order: 40
status: stable
---

# Events, Deliveries, and Recovery

## The pain

A client sends "capture this note" and its connection drops before it hears
back. Did the note get saved? If the client sends again, will there be two
notes? Meanwhile the host restarts while `notes.capture` is halfway through its
work, and a dashboard that was following the operation simply stops. Each of
these needs a different answer, and guessing wrong either loses work or repeats
it.

## The problem

You need to know which identity answers which question:

- what one request is, and how a retry finds it again;
- which work is guaranteed to run, how often, and what happens when it keeps
  failing;
- what an observer sees live versus on replay, and what "done" means for each;
- what stops watching and what stops the work.

## The solution

Copilotz separates four things.

| Concept               | What it is                                                                                                        | Lifetime                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Operation**         | One admitted request, created by `app.send`, with a state: active, then `completed`, `failed` or `cancelled`      | Durable, looked up by ID |
| **Durable Event**     | An immutable fact (`notes.capture.requested`, `note.created`, `notes.save.completed`) with a database position    | Durable, never edited    |
| **Delivery**          | One obligation for one durable Processor to handle one Event                                                      | Durable until settled    |
| **Action invocation** | One recorded call of an Action inside a delivery, with `invoked` then `completed`, `failed` or `cancelled` Events | Durable, reused on retry |

Ephemeral Events, such as stream frames, are never stored. Every Event carries a
`correlationId`, which normally propagates from the triggering Event, and Events
created in response to another Event carry a `causationId` pointing at it; a
root request has none. Correlation is for attribution and observation, not
settlement membership: detached work can keep the correlation while settling
separately from the operation.

Ordinary `app.maintenance()` never compacts durable Events or their bodies; they
remain the replay sources and retry receipts. It does compact settled delivery
rows, retire expired observation-stream bytes and prune metadata for terminal
operations past its retention settings. That retention can end operation lookup
and attachment replay for an old operation even though its durable Events
remain.

### Admission: one request, one operation

`app.send` records the request Event and its deliveries atomically. To make a
client retry safe, give it an explicit `deduplicationId` **and** an explicit
`correlationId`, and resend the complete input unchanged. A repeat returns the
original `operationId` and `eventId` and runs no new delivery.

Both are part of the Event's identity. If you omit `correlationId`, `app.send`
generates a new one on each call, so a resend that reuses only the
`deduplicationId` is a different Event with a reused ID and is rejected with
`event_deduplication_conflict`. Changing the payload or type under the same
`deduplicationId` is rejected the same way.

`deduplicationId` is admission identity only. It does not name Action calls or
Collection writes; those use operation keys, described below.

### Deliveries run at least once

A delivery exists only for a matched durable Processor; observers and streams
create no delivery. Its states are `pending`, `leased`, `retry_wait`,
`succeeded`, `cancelled` and `dead_letter`.

- **Leases and recovery.** A worker leases a delivery while it runs it. Pending
  deliveries, deliveries waiting for a retry, and leased deliveries whose lease
  has expired are eligible again. A worker that opens the same database, schema
  and namespace, with the same Processor registered, can claim them once they
  are due. There is no promise of immediate execution at startup, and
  dead-lettered, cancelled or succeeded deliveries never rerun automatically.
- **Bounded retries.** An unknown error is retryable: the delivery waits in
  `retry_wait` and runs again until it succeeds or uses its attempts. Then it is
  `dead_letter`, and an inheriting operation fails.
- **Non-retryable failures.** Wrap a deterministic failure with
  `markNonRetryable(error)` to dead-letter it on the current attempt. Collection
  schema-validation errors are already marked.
- **Recording a domain outcome.** A Processor may declare
  `onError(error, event, context)`. It runs only for the final failure (attempts
  used up, or non-retryable), under the same lease and context, and never after
  cancellation or lease loss. Return `true` after you have recorded your own
  failure outcome, for example a `failed` record; the delivery then succeeds
  instead of dead-lettering. Return `false` to keep the failure.

Because a delivery can run more than once, the effects it repeats must resolve
to what was already stored:

- An ordinary Action call from a Processor is identified by the delivery, its
  call position in the handler, the Action ID and an optional key. Two
  successive calls with the same key are **distinct** calls; a retried handler
  replays the same positions and gets the recorded results back.
- `caller.prepare` identifies a call by the delivery, the Action ID and a
  required key, with no position, and reuses its captured input.
- A nested call made from inside an Action is identified by the parent Action
  run, the Action ID and its explicit key, or its call position when it has no
  key.
- Direct Collection writes are delivery-scoped. Inside an Action, prefix their
  key with `context.operationKey`, as `notes.save` does with
  `${context.operationKey}:save-note`, so two calls of the same Action in one
  delivery cannot collide.

Copilotz guarantees this only for what it records. A payment or email API call
needs that service's own idempotency key, derived from the same stable identity.

### Settlement: what `done` waits for

Matched Processors **inherit** the triggering operation by default: the
operation completes only when their deliveries settle, and fails when one
dead-letters. A Processor with `settlement: "detached"` runs durable background
work that keeps its causation but does not block or fail the operation.

### Observing: live outputs versus replay

| Handle                        | `outputs`                                                                  | `done`                                                                        |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `app.send(input)`             | What happens while you watch. A deduplicated resend sees only live outputs | Resolves on `completed`; **rejects** when the operation fails or is cancelled |
| `app.attach({ operationId })` | Replays recorded Events from the start, then follows until final           | Resolves when replay reaches **any** final state; check that state yourself   |

A replay ends with one unstored output, `operation.completed`,
`operation.failed` or `operation.cancelled`. `app.operationStatus` returns the
recorded state, or `null` when the namespace has no such operation.

Read `outputs` while waiting for `done`; a stream nobody reads can hold
settlement back.

### Detach versus cancel

- `handle.detach()` and `attachment.detach()` stop **this observer** only. The
  durable operation keeps running.
- `app.close()` stops this process's observers and workers and releases the
  resources it owns. It does not cancel durable work, and it does not wait for
  all outstanding work to finish; unfinished deliveries stay recoverable.
- `handle.cancel()` and `app.cancelOperation({ operationId })` record a
  **durable** cancellation. Unfinished deliveries become `cancelled` and the
  operation ends `cancelled`. Cancellation does not undo writes already
  committed or external effects already made.

### Reading Events safely

Outputs and Processor Events are either durable or ephemeral. Check `durable`
(or `isDurableEvent`) before using `id` or `position`: only durable Events have
them. A position orders Events within one database; it is not a global clock,
and it is unrelated to record IDs. Processors read the resolved body from
`event.data`.

### Example: resend safely and confirm the outcome

This entrypoint saves one note under a request ID that the client chooses. Run
it twice with the same ID and only one note exists. It uses the Notes
`composition.ts` from
[Chapter 7](./getting-started/part-2-verify-and-recover/07-persist-and-recover.md),
with its persistent `database`, `namespace` and `runtimePlugins`. Create
`capture-once.ts`:

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of one send input and one output.
import type {
  ApplicationOutput,
  ApplicationSendInput,
} from "@copilotz/copilotz";
// The application's shared host choices.
import { database, namespace, runtimePlugins } from "./composition.ts";
// Command-line arguments and the exit code, on both Deno and Node.
import process from "node:process";

const [requestId, text] = process.argv.slice(2);
if (!requestId || !text) {
  throw new Error("Usage: capture-once.ts <request-id> <note text>");
}

// One complete input, rebuilt identically on every attempt. Both identities
// derive from the client's request ID, so a resend finds the same operation.
const request: ApplicationSendInput = {
  type: "notes.capture.requested",
  payload: { text },
  correlationId: `capture:${requestId}`,
  deduplicationId: `capture:${requestId}`,
};

// Prints durable Event facts only; payloads may contain caller data.
async function drain(outputs: ReadableStream<ApplicationOutput>) {
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      // Release byte streams so they do not hold settlement open.
      await output.payload.cancel();
    } else if (output.durable) {
      console.log(`event ${output.type} position=${output.position}`);
    }
  }
}

const app = await createCopilotz({
  namespace,
  database,
  plugins: runtimePlugins,
});

// Any live, replay or settlement failure makes the run unsuccessful, even if
// the stored state later reports `completed`.
let exitCode = 0;

try {
  // A repeat with the same input returns the original operation.
  const handle = await app.send(request);
  console.log(`operation ${handle.operationId}`);

  // Wait for both the reader and settlement, so no drainer is left running.
  // `send.done` rejects on failure; the message is fixed because the error
  // may echo caller data.
  const live = await Promise.allSettled([drain(handle.outputs), handle.done]);
  if (live.some((result) => result.status === "rejected")) {
    console.error("live send did not complete successfully");
    exitCode = 1;
  }

  // Replay the recorded history. This only reads; nothing runs again.
  const attachment = await app.attach({ operationId: handle.operationId });
  const replay = await Promise.allSettled([
    drain(attachment.outputs),
    attachment.done,
  ]);
  if (replay.some((result) => result.status === "rejected")) {
    console.error("replay did not complete successfully");
    exitCode = 1;
  }

  // `attach.done` resolves for any final state, so check which one it was.
  const status = await app.operationStatus({ operationId: handle.operationId });
  console.log(`final state: ${status?.state ?? "unknown"}`);
  if (status?.state !== "completed") exitCode = 1;
} catch {
  // Admission or attach rejected; keep the message free of caller data.
  console.error("capture request could not be admitted or attached");
  exitCode = 1;
} finally {
  // Release the database even after a failure.
  await app.close();
}

// Set the exit code only after close, so host shutdown cannot overwrite it.
process.exitCode = exitCode;
```

Run it twice with the same request ID:

```sh
deno run -A capture-once.ts req-1 "Prepare the release."
deno run -A capture-once.ts req-1 "Prepare the release."
# Node 24+: node capture-once.ts req-1 "Prepare the release."
```

The first run prints the live `notes.capture.requested`, `notes.save.*` and
`note.created` Events, then the same Events again on replay. The second run
prints the same operation ID, **no** live Events (Notes has no detached work
that could emit late outputs), and the same replayed history with one
`note.created`.

### Diagnostics are observations, not records

`createCopilotz` accepts `onDeliveryDiagnostic(diagnostic)`, an opt-in,
best-effort, process-local observer of delivery timing. When a Processor throws,
the `worker_handler_settled` diagnostic carries the new delivery `status` and an
`error` limited to `{ name, message }`. Diagnostics are never persisted, and a
sink that throws or rejects is ignored. A synchronous sink adds latency to each
delivery, so keep it fast. Common credential shapes in the message are masked,
but that is a courtesy, not a redaction guarantee: do not put secrets in error
messages.

## Reference

- **Schema.** Startup provisions a fresh database and validates an existing one.
  An incompatible schema is rejected; Copilotz performs no automatic migration
  or reset.
- **Persistence outage.** Copilotz-owned persistence reconnects and recovers
  durable deliveries but never replays the SQL statement that hit the outage.
  Active `send` handles reject; their durable work stays recoverable and is not
  marked cancelled.
- **Ownership.** Leasing, recovery and dead-letter handling belong to the
  runtime and host. Applications see status, attach and cancellation;
  `app.maintenance()` performs only bounded, safe cleanup.
- **History.** Changes made in 0.76.0 and earlier releases are listed under
  Release history in [Upgrading](./upgrading.md).

### Core history indexes

Core hosts should call `provisionCoreHistoryIndexes` from
`@copilotz/copilotz/core` once per physical schema after provisioning the Event
schema. This installs the chronological Message index and its statistics;
existing PostgreSQL schemas can use `{ concurrently: true }` outside a
transaction. See [history performance](./history-performance.md) for the access
path, explicit provisioning CLI, and native regression benchmark. This is
explicit provisioning, never request-time DDL.

### Upgrade to indexed observations

Stop all old application writers and workers before upgrading each physical
schema. The upgrade runs in a transaction with exclusive catalog/Event table
locks, assigns operation-local event ordinals to committed history, and builds
selection membership. It does not rewrite Event content or Body storage. A
failed transaction rolls back; retrying a completed upgrade validates and
returns.

```ts
// Generic offline upgrade over the host-owned SQL session and physical schema.
import { upgradeOperationCatalog } from "@copilotz/copilotz/streams";
// Core resolves its legacy conversation associations; other domains use their own resolver.
import { resolveCoreObservationKeys } from "@copilotz/copilotz/core";

// The host migration entrypoint supplies sqlSession and databaseSchema.
await upgradeOperationCatalog(sqlSession, databaseSchema, {
  // Translate Core associations into opaque selection keys.
  resolveObservationKeys: resolveCoreObservationKeys,
  // Legacy metadata fields read during this one offline backfill.
  backfillMetadataKeys: ["observationKeys", "core", "operationMetadata"],
});
```

The resolver is domain-owned: Core maps legacy Thread metadata to opaque keys;
other domains supply their own resolver. Fresh Event producers declare
`metadata.observationKeys`. Later Events inherit their operation's associations.
Catalog SQL never interprets Core Thread metadata.

Deploy matching server and client versions, refresh canonical history to obtain
new checkpoints, and then resume traffic. The `operation-selections-v1` cursor
rejects earlier cursor generations with `invalid_replay_cursor`; an old global
Event position must never be interpreted as an operation-local ordinal. Do not
restart old writers against the upgraded catalog. Keep a database backup and the
previous artifact for an operator-managed rollback.

### Observation cost and recovery

Within one application process, selection-head scans batch up to 1,000 opaque
keys. They run on scoped, coalesced notifications and every five seconds as a
safety check. Only changed selections query their indexed operation
associations. Generic metadata-search APIs remain available for explicit generic
queries; the conversation observation path does not use them.

Resource checks run every 250 ms, batching only equivalent namespace, collection
and permission predicates. An exact resource-ID equality may be factored into
its watcher's ID set; all other predicates remain in SQL. Admission
authorization remains the host's responsibility. This does not add a new
participant permission revalidation policy to hosts that only supplied an ID
predicate.

Each operation has a shared event/topology reader and live Body followers.
Historical replay remains per viewer and joins live reads without skipping
bytes. Queues are bounded per viewer; a slow viewer renews independently. Only
checkpoints whose frame handlers completed are used on reconnect. At most 32
operations are attached concurrently; terminal work retires as its lanes
complete. Retained terminal markers bridge discovery pages without replaying
completed work.

HTTP observations renew after five minutes even when no output arrives. Expiry
immediately detaches database readers; a blocked network response cannot retain
those readers indefinitely. The client reconnects with its last applied cursor.
Malformed protocol frames remain errors, while planned renewal is retryable.
There is no additional durable payload feed or external broker. Multiple server
processes each own their coordinator; load therefore also depends on replica
count, permission diversity, active operations and reconnect frequency.

Measured capacity and the reproducible benchmark method are documented in
[Observation performance](./observation-performance.md).

## What this unlocks

- Clients can retry after a lost response without creating duplicate work.
- Restarts and lease expiry resume unfinished work, and stable keys turn
  repeated effects into stored results.
- Observers can disconnect and reattach from any process, and only an explicit
  cancellation changes the work.
- Final failures can be recorded as domain outcomes instead of silent dead
  letters.

## Next steps

- [Chapter 7: Persist and Recover](./getting-started/part-2-verify-and-recover/07-persist-and-recover.md)
  walks through replaying an operation after a restart.
- [Actions](./actions.md) details Action invocation identity and operation keys.
- [Plugins and Processors](./plugins-and-processors.md) covers matching,
  settlement and `onError` declarations.
- [Testing and Inspection](./testing-and-inspection.md) shows how to assert
  deduplication, failures and replays.
