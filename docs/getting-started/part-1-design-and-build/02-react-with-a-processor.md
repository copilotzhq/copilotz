---
title: "Chapter 2: React With a Processor"
description: "Register a Processor that Copilotz runs for every matching Event, reading the Event's resolved data instead of being called by the sender."
section: Getting Started
order: 20
status: stable
---

# Chapter 2: React With a Processor

> Part 1 — Design and Build · Track: R · Requires: Chapter 1 · Needs: Deno 2.9+
> or Node 24+ (no credential)

## The pain

In Chapter 1, `app.ts` records every `notes.capture.requested` Event, and then
nothing happens. The obvious fix is to call a function right after `app.send`,
in the sender. That ties the reaction to that one caller: a second sender, such
as an HTTP route or a scheduled job, would have to remember to call the same
function. The function would also run outside the operation, so `done` would
settle before the reaction finished, and a crash would leave no record that the
reaction was still owed.

## The problem

A reaction belongs to the Event type, not to whoever sent the Event. The runtime
has to know which code is subscribed to which Event types, record that work is
owed for each matching Event, run that code with the Event's data, and count it
as part of the operation before `done` settles. The sender should only need to
name the Event type.

## The solution

Register a **Processor**: a named subscription that Copilotz runs for every
durable Event it matches. When `app.send` commits an Event, the runtime checks
the registered Processors. For each match it records a **delivery**, which is
the durable obligation to run that Processor for that Event, and then runs the
Processor's `handle` function.

The handler is not called by the sender, and it does not receive the sender's
object. It receives the stored Event, and reads its payload from `event.data`,
which the runtime resolves from the stored Event for consumers. Read
`event.data` rather than the Event's raw stored fields.

A Processor has three parts:

- `id` is its stable identity. Copilotz records it on each delivery, so a
  delivery that is still owed can find its handler again. Keep it unchanged once
  the application has stored Events.
- `on` lists the Events it matches. Each entry needs an `eventType`.
- `handle(event)` is the work to do for each matching Event.

By default a Processor's settlement is `inherit`: its delivery takes part in the
operation that caused it, so `handle.done` resolves only after the handler has
finished.

Two limits matter in this chapter:

- **The reaction here is only a console message.** It demonstrates that the
  handler ran with the Event's data. It saves nothing, so there is still no
  durable note. Chapter 3 saves the note as state.
- **Deliveries run at least once.** If a handler fails with a retryable error or
  its lease expires, the runtime can run the same delivery again. A console
  message can then appear more than once for one Event. Unknown errors count as
  retryable, so they are retried until a bounded number of attempts runs out. An
  error explicitly classified as non-retryable ends the delivery on its current
  attempt. Either way, a delivery that finally fails makes `handle.done` reject.
  Later chapters use runtime operations that are safe to repeat.

### Edit `app.ts`

`app.ts` stays an **entrypoint** and needs no new package or credential. This
step makes three changes to it:

1. It adds `defineProcessor` to the `@copilotz/copilotz` import.
2. It inserts the `captureNote` declaration before `createCopilotz`.
3. It adds a `processors` map with `captureNote` to the `createCopilotz`
   options.

The complete updated file:

```ts
// Runtime factory, the Processor helper, and the guard that separates byte
// streams from Events.
import {
  createCopilotz,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Type of each item that an operation's outputs stream yields.
import type { ApplicationOutput } from "@copilotz/copilotz";
// The note text comes from the command line, so each run can send new input.
import { argv } from "node:process";

// Prints everything the operation produces, in the order it arrives.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    // Byte streams, such as streamed model text, are a separate kind of output.
    // This app opens none; later chapters read them.
    if (isStreamOutput(output)) {
      console.log(`stream ${output.streamId} (${output.mediaType})`);
      continue;
    }
    // Durable Events are committed to the database, so they carry a stable ID
    // and a database-assigned position. `data` is the Event's resolved payload.
    if (output.durable) {
      console.log(
        `event ${output.type} id=${output.id} position=${output.position} data=${
          JSON.stringify(output.data)
        }`,
      );
      continue;
    }
    // Live Events are delivered to current observers and never stored.
    console.log(`live ${output.type} data=${JSON.stringify(output.data)}`);
  }
}

// Reacts to every capture request, whoever sent it. The sender only names the
// Event type; the runtime selects this Processor and runs it.
const captureNote = defineProcessor({
  // Stable identity recorded on each delivery. Keep it once Events are stored.
  id: "notes.capture",
  // Match every Event of this type, in any namespace this application admits.
  on: [{ eventType: "notes.capture.requested" }],
  // Runs for the delivery the runtime selected for a matching Event, and may
  // run again for the same delivery on retry. Its default `inherit` settlement
  // makes the operation wait for this handler before settling.
  handle(event) {
    // The handler's Event type also covers live Events, which are never stored
    // and have no ID. Confirm this is a stored Event before reading its `id`.
    if (!event.durable) return;
    // `event.data` is the resolved payload. Nothing validates its shape yet, so
    // read `text` defensively.
    const text = (event.data as { text?: unknown } | null)?.text;
    // Demonstration only: proves the handler saw the data. It saves nothing,
    // and a retried delivery can print it again.
    console.log(
      `notes.capture handled event ${event.id}: ${JSON.stringify(text)}`,
    );
  },
});

// Compose an application with one Processor. Omitting `database` gives this
// application a private in-memory database that lasts until the application
// closes or the process exits.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event this application admits.
  namespace: "team-notes",
  // Processors this application runs, keyed by a local name. Copilotz
  // identifies each one by its `id`, not by this key.
  processors: { captureNote },
});

try {
  // Admit one named input. Copilotz commits it as a durable Event, records a
  // delivery for each matching Processor, and starts an operation that covers
  // that work.
  const handle = await app.send({
    // Stable name that the `notes.capture` Processor matches.
    type: "notes.capture.requested",
    // Plain JSON data, delivered to the Processor as `event.data`.
    payload: { text: argv[2] ?? "Prepare the release." },
  });
  console.log(
    `accepted operation ${handle.operationId} (input event ${handle.eventId})`,
  );

  // Read outputs while waiting for settlement. `done` resolves only after the
  // inherited Processor delivery succeeds. Wait for both the reader and
  // settlement before cleanup, even if either fails.
  const [drained, settled] = await Promise.allSettled([
    printOutputs(handle.outputs),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;

  // Read the operation's recorded state back from the runtime by its ID.
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(
    `settled operation ${handle.operationId}: ${status?.state ?? "unknown"}`,
  );
} finally {
  // Stop the runtime and release its database, including after a failure.
  await app.close();
}
```

The `app.send` call has no reference to `captureNote`. Removing the Processor
from `processors` would leave the sender unchanged, and the Event would still be
recorded.

If the handler throws an unknown or retryable error, the delivery is retried
until its attempts run out; an error classified as non-retryable ends it at
once. When the delivery finally fails, `handle.done` rejects, the error
propagates after `close()` finishes, and the process exits with a non-zero
status.

## Check it works

Run the entrypoint with a note of your own, using either runtime:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno run -A app.ts "Prepare the release."
# Node 24+: runs app.ts directly by stripping its type annotations.
node app.ts "Prepare the release."
```

The output has this shape. The IDs change on every run. The script prints the
`accepted` line before it starts reading outputs, but the handler runs
concurrently with that reading, so the handler line's position relative to the
`accepted` and `event` lines can vary:

```text
accepted operation 3f6c… (input event 3f6c…)
notes.capture handled event 3f6c…: "Prepare the release."
event notes.capture.requested id=3f6c… position=1 data={"text":"Prepare the release."}
settled operation 3f6c…: completed
```

Check these facts rather than the handler line's exact position:

- A `notes.capture handled event` line appears, and it shows the text you
  passed. Its Event ID equals the input event ID on the `accepted` line.
- That line appears before the `settled operation` line. The Processor's
  delivery inherits the operation's settlement, so `done` waits for the handler.
- Exactly one `event` line appears, still of type `notes.capture.requested`. The
  handler printed a message but emitted no new Event.
- The last line reports the operation state `completed`.

The only ordering this script guarantees for the handler line is that it comes
before `settled operation`. In this run it normally appears once; under a retry
it could appear again.

Each run still uses a new in-memory database, so nothing from earlier runs
remains, and no note is stored anywhere.

## What this unlocks

Code can now react to an Event without the sender knowing about it. Keep the two
roles apart:

- An **Event** is a recorded fact: this request happened, with this data.
- A **Processor** is durable work that the runtime selects for matching Events
  and tracks as a delivery until it succeeds.

You can add more reactions to `notes.capture.requested` by registering more
Processors, and any future sender of that Event type triggers them all. Each
reaction is covered by the operation by default, so `done` and
`app.operationStatus` report the work, not just the admission.

## Next steps

- Next:
  [Chapter 3: Keep State in a Collection](03-keep-state-in-a-collection.md)
  replaces the console message with a note saved as durable state.
- Reference: [Plugins and Processors](../../plugins-and-processors.md) covers
  matchers, settlement modes and Processor context.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains deliveries, at-least-once execution and retries.
