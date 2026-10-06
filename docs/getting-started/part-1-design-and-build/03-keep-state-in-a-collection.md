---
title: "Chapter 3: Keep State in a Collection"
description: "Store each captured note as a schema-checked Collection record, and read the immutable note.created fact that every write appends."
section: Getting Started
order: 30
status: stable
---

# Chapter 3: Keep State in a Collection

> Part 1 — Design and Build · Track: R · Requires: Chapter 2 · Needs: Deno 2.9+
> or Node 24+ (no credential)

## The pain

In Chapter 2, the `notes.capture` Processor runs for every capture request,
prints the text and then forgets it. The obvious next step is to push the text
into an array or append it to a JSON file. Nothing would check that each entry
has a text, nothing would record which request produced which entry, and other
code could not react to a new note without polling the file. Worse, deliveries
run at least once: a retried handler would append the same note a second time.

## The problem

Application state needs three guarantees that a plain array or file does not
give:

- **A checked shape.** Every stored record has to match a declared schema before
  it is saved.
- **A recorded fact for every change.** Each write has to leave an immutable,
  ordered record of what changed and which request caused it, so that other code
  can react to it and a later reader can trace it.
- **Writes that survive a retry.** When the runtime runs a delivery again, its
  writes have to resolve to the result already stored, not to a duplicate.

## The solution

Declare a **Collection**: named application state with a JSON Schema. Each
mutation goes through the runtime, which validates the record, stores it and
appends a durable Event describing the change, all in one step. Creating a
`note` record appends a `note.created` Event. These Events are facts, like the
`notes.capture.requested` input: other Processors can subscribe to them, and
they join the operation that caused them.

`defineCollection` takes the Collection's `name` and its record `schema`. The
name is part of every Event type the Collection appends, so keep it stable once
the application has stored records. The Record and insert types are derived from
the schema, so declare it `as const`.

Register the Collection under `collections` in `createCopilotz`. Processors then
reach its runtime operations through their context, under the same key:
`context.collections.note.create(...)` validates and stores one record and
resolves to the stored record.

The data of a `note.created` Event holds the stored `record`: your `text`, plus
the `id`, `namespace`, `createdAt` and `updatedAt` fields that the runtime fills
in. It also carries `operation`, `intent` and `assets`, which the runtime uses
for retries and attached content. This chapter reads the `record` from the
operation's outputs: the immutable fact that the note was created, as it was
committed.

A write from a Processor needs a stable **operation key**. The runtime combines
it with the current delivery, so it names this one write for this one delivery:

- A retried delivery reuses the key, so `create` returns the note the first
  attempt already stored and no second `note.created` Event appears. This is
  what makes an at-least-once handler safe to run again.
- The key is not a note ID and not a global singleton. Every new capture request
  gets its own delivery, so `capture-note` creates a new note each time.
- Use a different key for each distinct write in the same handler. Reusing a key
  for a different write in the same delivery is rejected.

Without a record `id` or an `operationKey`, a Collection write inside a
Processor is rejected, so a retry can never duplicate it by accident.

Two limits matter in this chapter:

- **The schema checks the stored record, not the request.** Nothing validates
  the `notes.capture.requested` payload yet. If its `text` is missing or is not
  a string, the `create` call fails schema validation. That failure is not
  retryable, so the delivery fails at once and `handle.done` rejects. Chapter 4
  validates input at the boundary with an Action.
- **The state is still temporary.** With no `database` option, the application
  owns a private in-memory database that belongs to this process. Notes live
  there until the application closes or the process exits. Chapter 7 keeps them
  in a local directory across restarts.

### Edit `app.ts`

`app.ts` stays an **entrypoint** and needs no new package or credential. This
step makes five changes to it:

1. It adds `defineCollection` to the `@copilotz/copilotz` import, and
   `CollectionCreated` to the type import.
2. It inserts the `note` Collection and the `NoteRecord` type before
   `printOutputs`.
3. It inserts a `note.created` branch inside `printOutputs`, before the general
   durable Event line.
4. It replaces the body of the `captureNote` Processor's `handle` function so
   that it creates a note instead of printing.
5. It adds a `collections` map with `note` to the `createCopilotz` options.

The complete updated file:

```ts
// Runtime factory, the Collection and Processor helpers, and the guard that
// separates byte streams from Events.
import {
  createCopilotz,
  defineCollection,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types of each output item and of the data a Collection's create Event holds.
import type { ApplicationOutput, CollectionCreated } from "@copilotz/copilotz";
// The note text comes from the command line, so each run can send new input.
import { argv } from "node:process";

// Application state for captured notes. Every record is checked against this
// schema before it is stored, and every change appends a `note.*` Event.
const note = defineCollection({
  // Stable name. It prefixes the Event types this Collection appends, such as
  // `note.created`, so keep it once records are stored.
  name: "note",
  // JSON Schema for one stored record. `as const` lets the record types be
  // derived from it.
  schema: {
    type: "object",
    properties: {
      // Record identity. The runtime assigns it when the writer omits it.
      id: { type: "string", readOnly: true },
      // The note itself, as the user captured it.
      text: { type: "string" },
    },
    // A note without text is rejected before it is stored.
    required: ["text"],
  } as const,
});

// Shape of one stored note, derived from the Collection's schema.
type NoteRecord = typeof note.$inferSelect;

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
      // The `note` Collection appends this Event for each stored note. Its data
      // holds the record exactly as it was committed.
      if (output.type === "note.created") {
        const { record } = output.data as CollectionCreated<NoteRecord>;
        // The Event ID names the fact; `record.id` names the stored note.
        console.log(
          `event note.created id=${output.id} position=${output.position}`,
          `note=${record.id} text=${JSON.stringify(record.text)}`,
        );
        continue;
      }
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

// Turns every capture request, whoever sent it, into a stored note. The sender
// only names the Event type; the runtime selects this Processor and runs it.
const captureNote = defineProcessor({
  // Stable identity recorded on each delivery. Keep it once Events are stored.
  id: "notes.capture",
  // Match every Event of this type, in any namespace this application admits.
  on: [{ eventType: "notes.capture.requested" }],
  // Runs for the delivery the runtime selected for a matching Event, and may
  // run again for the same delivery on retry. Its default `inherit` settlement
  // makes the operation wait for this handler, and for the note it stores.
  async handle(event, context) {
    // Save notes only for stored requests, so every note traces back to a
    // recorded Event and its delivery.
    if (!event.durable) return;
    // `event.data` is the resolved payload. The request is still unvalidated;
    // the Collection schema rejects a missing or non-string `text`.
    const text = (event.data as { text?: unknown } | null)?.text;
    // Validate the record against the `note` schema, store it, and append a
    // `note.created` Event to this operation.
    await context.collections.note.create(
      // Only the note's own field. The runtime fills in `id`, `namespace` and
      // the timestamps.
      { text },
      // Names this one write within the current delivery. A retried delivery
      // reuses the key and gets back the note already stored, instead of a
      // duplicate. A new request has a new delivery, so it stores a new note.
      { operationKey: "capture-note" },
    );
  },
});

// Compose an application with one Collection and one Processor. Omitting
// `database` gives this application a private in-memory database that lasts
// until the application closes or the process exits.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event and record this application owns.
  namespace: "team-notes",
  // Collections this application stores, keyed by the name Processors use in
  // `context.collections`.
  collections: { note },
  // Processors this application runs, keyed by a local name. Copilotz
  // identifies each one by its `id`, not by this key.
  processors: { captureNote },
});

try {
  // Admit one named input. Copilotz commits it as a durable Event, records a
  // delivery for each matching Processor, and starts an operation that covers
  // that work, including the note it stores.
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
  // Processor delivery and its note write succeed, and Promise.all rejects as
  // soon as either side fails.
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

The sender is unchanged: it still sends `notes.capture.requested` and knows
nothing about the `note` Collection. The Processor owns the reaction, and the
Collection owns the state and its facts.

If the `create` call fails schema validation, the delivery fails without a
retry. Other unknown errors are retried until the delivery's attempts run out.
Either way `handle.done` rejects, the error propagates after `close()` finishes,
and the process exits with a non-zero status.

## Check it works

Run the entrypoint with a note of your own, using either runtime:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno run -A app.ts "Prepare the release."
# Node 24+: runs app.ts directly by stripping its type annotations.
node app.ts "Prepare the release."
```

The output has this shape. IDs and timestamps change on every run. Positions are
local to one database: each run recreates the private in-memory database, so the
same position numbers usually appear again.

```text
accepted operation 3f6c… (input event 3f6c…)
event notes.capture.requested id=3f6c… position=1 data={"text":"Prepare the release."}
event note.created id=8d2a… position=2 note=5b91… text="Prepare the release."
settled operation 3f6c…: completed
```

Check these facts rather than the exact IDs or position numbers:

- The `notes.capture.requested` line still shows the text you passed, and its
  `id` equals the input event ID on the `accepted` line.
- Exactly one `event note.created` line appears. Its `text` matches the text you
  passed.
- Its `note=` value is a generated record ID. It differs from the Event's own
  `id`: one names the stored note, the other names the fact that it was created.
- Within this run, the `note.created` Event's position is later than the
  input's. Compare the two positions with each other, not with fixed values.
  Both lines appear before the `settled operation` line, because the note write
  took part in the operation.
- The last line reports the operation state `completed`.

The script guarantees only that every Event in the operation's scope is printed
before `settled operation`; it does not promise any other interleaving.

Each run still starts with a new in-memory database, so a second run stores one
new note and keeps nothing from the first.

## What this unlocks

The application now has state with a checked shape, and every change to it is a
recorded fact. You can:

- store records that must match a schema, with IDs and timestamps assigned by
  the runtime;
- react to new notes by subscribing a Processor to `note.created`, without
  touching the code that stores them;
- run handlers that write state at least once, because a retried delivery
  resolves to the write it already made.

Reading records back by ID or by query is covered in the
[Collections reference](../../collections.md). Serving records over HTTP is a
separate exposure decision: the [Server reference](../../server.md) explains how
to enable record reads explicitly. Chapter 15 adds HTTP admission for Actions
only and keeps Collection routes disabled.

## Next steps

- Next:
  [Chapter 4: Share Operations as Actions](04-share-operations-as-actions.md)
  moves the save logic into an Action with validated input, so any caller can
  save a note the same way.
- Reference: [Collections](../../collections.md) covers schemas, record reads,
  queries, updates and the Events each mutation appends.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains deliveries, retries and how operation keys make writes safe to
  repeat.
