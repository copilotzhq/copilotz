---
title: "Chapter 1: Send Your First Event"
description: "Send a named input to the Copilotz runtime, read the durable Event it becomes, and wait for the operation it started to settle."
section: Getting Started
order: 10
status: stable
---

# Chapter 1: Send Your First Event

> Part 1 — Design and Build · Track: R · Requires: setup · Needs: Deno 2.9+ or
> Node 24+ (no credential)

## The pain

The Notes application starts with one request: "capture this note". The obvious
first version is a function call, such as `captureNote("Prepare the release.")`.
To quote that request in a support ticket, let other code react to it, or check
later whether it finished, you would have to add the bookkeeping yourself: an
ID, a stored record, a log of what followed and a way to tell when it was done.
Every caller then has to use that bookkeeping the same way, or the records drift
apart.

## The problem

Before work can be observed, shared or recovered, the request itself needs an
identity, and that identity has to be recorded before any work begins. A plain
function call does not supply that contract by itself. The request needs to
become a stored fact with a stable name and ID, the work it starts needs to be
traceable back to it, and there needs to be one agreed point at which that work
counts as settled.

## The solution

Send the request to the Copilotz runtime as a named input. `app.send` admits the
input and commits it to the application's database as a **durable Event**: an
immutable record with an ID and a position that orders it among the Events in
that database. It also starts an **operation** and returns a handle to it. The
operation covers the input Event and the work that takes part in its scope.
Processor work caused by the Event takes part by default; later chapters
introduce background work that is detached from the operation.

- `operationId` names the operation. You can ask for its status by this ID.
- `eventId` is the ID of the stored input Event. For an input sent with
  `app.send`, the operation is named after its input Event, so the two IDs
  match.
- `correlationId` links this operation's output Events to the input.
- `outputs` is a stream of what the operation produces. It closes when the
  operation settles.
- `done` resolves when the operation settles successfully, and rejects if the
  operation fails.

The application has no Processors, Actions or Collections yet, so nothing reacts
to this Event. The operation settles once the input is admitted. That is enough
to see the Event's identity and the operation's lifecycle before any behaviour
is added.

Two limits matter in this chapter:

- **A named input is not a validated command.** The Event type is a non-empty
  name your application chooses, and no payload schema is installed yet: the
  runtime stores the plain JSON payload as sent. Nothing checks that `text` is
  present or is a string. Validated input arrives with Actions in Chapter 4.
- **Durable means recorded in the database, and this database is temporary.**
  With no `database` option, the application owns a private in-memory database.
  Events and operation states live there until the application closes or the
  process exits, whichever comes first. Chapter 7 switches to a local directory
  that survives restarts. Copilotz records Events and operation states, not
  every line of your code: an ordinary function you call is not recorded step by
  step.

### Create `app.ts`

The setup step already installed everything this chapter needs, and it needs no
credential. `app.ts` is an **entrypoint**: it composes the application, sends
one input taken from the command line, prints what happened and closes the
application.

```ts
// Runtime factory, plus the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
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

// Compose an application with no plugins yet. Omitting `database` gives this
// process a private in-memory database that disappears when the process exits.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event this application admits.
  namespace: "team-notes",
});

try {
  // Admit one named input. Copilotz commits it as a durable Event and starts an
  // operation that covers everything the Event causes.
  const handle = await app.send({
    // Stable name that later Processors and Actions react to.
    type: "notes.capture.requested",
    // Plain JSON data. Nothing validates its shape yet.
    payload: { text: argv[2] ?? "Prepare the release." },
  });
  console.log(
    `accepted operation ${handle.operationId} (input event ${handle.eventId})`,
  );

  // Read outputs while waiting for settlement. `outputs` closes when the
  // operation settles, and Promise.all rejects as soon as either side fails.
  await Promise.all([printOutputs(handle.outputs), handle.done]);

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

If sending, reading outputs or settlement fails, the error propagates after
`close()` finishes. Deno and Node then print it and exit with a non-zero status.

## Check it works

Run the entrypoint with a note of your own, using either runtime:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno run -A app.ts "Prepare the release."
# Node 24+: runs app.ts directly by stripping its type annotations.
node app.ts "Prepare the release."
```

The output has this shape. The IDs change on every run:

```text
accepted operation 3f6c… (input event 3f6c…)
event notes.capture.requested id=3f6c… position=1 data={"text":"Prepare the release."}
settled operation 3f6c…: completed
```

Check these facts rather than the exact IDs:

- Exactly one `event` line appears. Its type is `notes.capture.requested`, and
  its data is `{"text":"Prepare the release."}`, or the text you passed.
- That Event's `id` equals the input event ID on the `accepted` line, and the
  operation ID matches it too.
- The Event has a `position`. In a new, empty database the first input is
  usually at position `1`.
- The last line reports the operation state `completed`.

`completed` means the runtime admitted the input and settled the work in the
operation's scope. Nothing reacted to the Event yet, so no note was saved.

Each run starts with a new, empty in-memory database. A second run produces new
IDs and keeps nothing from the first, but its first Event can be at position `1`
again. A position orders Events within one database; it does not identify a
request across databases. Use the Event ID or operation ID for that.

## What this unlocks

Every request to the application can now be a named, identified Event instead of
an anonymous function call. You can:

- quote one operation ID for the request and the work in its scope;
- read the request's outputs as they are produced;
- ask the runtime for an operation's state by ID with `app.operationStatus`.

The Event type `notes.capture.requested` is now a contract that other code can
react to without the sender knowing about it.

## Next steps

- Next: [Chapter 2: React With a Processor](02-react-with-a-processor.md)
  registers code that reacts to this Event's data.
- Reference: the [Copilotz overview](../../overview.md) explains how Events,
  operations and the five primitives fit together.
- Reference: the [runtime API](../../api.md) lists the application's `send`,
  `operationStatus` and `close` methods.
