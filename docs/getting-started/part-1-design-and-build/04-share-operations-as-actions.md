---
title: "Chapter 4: Share Operations as Actions"
description: "Move the note write into a validated notes.save Action with a recorded lifecycle, and let the Processor decide when to call it."
section: Getting Started
order: 40
status: stable
---

# Chapter 4: Share Operations as Actions

> Part 1 — Design and Build · Track: R · Requires: Chapter 3 · Needs: Deno 2.9+
> or Node 24+ (no credential)

## The pain

In Chapter 3, the `notes.capture` Processor both reacts to the request and
stores the note. The save logic lives inside one Event subscription. An HTTP
route, a scheduled job or an agent tool that also needs to save a note would
have to copy that code, along with its operation key and its checks.

The only check today is the stored record's schema. It requires `text` to be a
string, so an empty string passes and is saved as an empty note. The application
does record the capture request and the resulting `note.created` fact, but the
save itself leaves no trace of its own: no distinct record that a save operation
started, which input it accepted, or which value it returned to its caller.

## The problem

Behaviour that several callers share needs an owner that is separate from any
one trigger. That owner has to:

- **Check its input at the boundary**, before any work starts, whoever the
  caller is.
- **Record each call as a unit**: that it started, with which input, and how it
  finished, including its result.
- **Stay safe to repeat.** A caller that runs at least once must not cause a
  second save.

The trigger, meanwhile, should only decide _when_ the work happens.

## The solution

Define an **Action**: a named, validated operation with a stable ID, an input
schema and an `execute` function. An Action does not subscribe to Events and
never runs on its own. A caller invokes it, and every call goes through the
runtime:

1. The runtime checks the input against `inputSchema`. Input that fails is
   rejected before this Action's lifecycle or `execute` starts, so the call
   leaves no `notes.save.*` Event. Events recorded earlier, such as the
   `notes.capture.requested` input, stay recorded.
2. It appends a `notes.save.invoked` Event holding the input.
3. It runs `execute` with the input and a runtime context.
4. It appends a `notes.save.completed` Event whose `output` is the value
   `execute` returned. If `execute` throws, the call ends with a failure Event
   instead.

The caller receives the same output that the completed Event records. These
lifecycle Events are part of the caller's operation, so `handle.done` waits for
the Action as well.

Here the `notes.capture` Processor is the caller. It no longer stores anything
itself: it hands `event.data` to the Action. The `note` Collection and its
schema stay as they are, so the stored record is still checked; the Action's
schema adds a stricter check on the request, requiring at least one character.

An Action has two names:

- `id`, here `notes.save`, is its stable identity. Lifecycle Event types are
  built from it, so keep it unchanged once Events are stored.
- The key under `actions` in `createCopilotz`, here `saveNote`, is the alias
  that callers use: `context.actions.saveNote(...)`.

Two operation keys are involved, and they have different scopes:

- The Processor calls the Action with `save-request`, which names this one call
  within the current delivery. If the delivery is retried after the Action has
  completed, the call resolves to the recorded output and `execute` does not run
  again.
- A Collection write inside an Action is **not** scoped to the Action call
  automatically. Its key is combined with the running delivery, exactly as in
  Chapter 3. A fixed key such as `save-note` would therefore name the same write
  for every `notes.save` call in one delivery, and a second call with different
  text would collide with the first.
- So the Action builds its write key from `context.operationKey`, a stable
  identity for this one Action call: `` `${context.operationKey}:save-note` ``.
  Two calls in the same delivery have different call identities, so they make
  two separate writes. A retry of the same call keeps the same identity, so if
  an interrupted call runs `execute` again, `create` returns the note that is
  already stored.
- A new capture request gets a new delivery, so the same keys save a new note
  each time.

Two limits matter in this chapter:

- **The expected Actions are a TypeScript type, not a permission.** The
  Processor declares the callers it expects by passing
  `ActionCallers<{ saveNote: typeof saveNote }>` as the third type parameter of
  `ProcessorContext`. Without it, the default caller type accepts no input
  (`never`), and `context.actions.saveNote(...)` does not type-check. The
  declaration gives ordinary TypeScript checking of the input and output. At run
  time the Processor still receives the complete context with every registered
  Action; nothing is granted, hidden or filtered. If `saveNote` were not
  registered, the code would still compile, and the call would fail when it ran.
- **Operation keys cover runtime writes only.** They make Collection writes and
  Action calls safe to repeat. If you later add an effect outside the runtime to
  `execute`, such as sending an email or calling a payment API, that effect
  needs its own idempotency, for example a provider idempotency key derived from
  `context.operationKey` in the same way as the note write.

### Edit `app.ts`

`app.ts` stays an **entrypoint** and needs no new package or credential. This
step makes five changes to it:

1. It adds `defineAction` to the `@copilotz/copilotz` import, and
   `ActionCallers`, `ActionCompletedData`, `ActionContext` and
   `ProcessorContext` to the type import.
2. It inserts the `SaveNoteInput` type and the `saveNote` Action after
   `NoteRecord`.
3. It inserts a `notes.save.completed` branch inside `printOutputs`, after the
   `note.created` branch.
4. It inserts the `CaptureContext` type before `captureNote`, types
   `captureNote` with it, and replaces the body of its `handle` function so that
   it calls the Action.
5. It adds an `actions` map with `saveNote` to the `createCopilotz` options.

The complete updated file:

```ts
// Runtime factory, the Collection, Action and Processor helpers, and the guard
// that separates byte streams from Events.
import {
  createCopilotz,
  defineAction,
  defineCollection,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types of each output item, of the data that Collection and Action Events
// hold, and of the contexts that Actions and Processors receive.
import type {
  ActionCallers,
  ActionCompletedData,
  ActionContext,
  ApplicationOutput,
  CollectionCreated,
  ProcessorContext,
} from "@copilotz/copilotz";
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

// Input that callers pass to `notes.save`. TypeScript checks calls against this
// type; the Action's `inputSchema` enforces the same shape at run time.
type SaveNoteInput = { text: string };

// Reusable, validated operation that stores one note. It runs only when a
// caller invokes it, and each call records its own lifecycle Events.
const saveNote = defineAction({
  // Stable identity. Lifecycle Event types are built from it, such as
  // `notes.save.invoked` and `notes.save.completed`, so keep it once Events are
  // stored.
  id: "notes.save",
  // Checked against every call's input before this Action's lifecycle Events
  // or `execute` start. Events recorded earlier stay recorded.
  inputSchema: {
    type: "object",
    properties: {
      // At least one character, so an empty note never reaches the Collection.
      text: { type: "string", minLength: 1 },
    },
    // A call without text is rejected before the Action starts.
    required: ["text"],
    // Reject unexpected fields instead of silently storing or dropping them.
    additionalProperties: false,
  } as const,
  // Runs once the input is accepted. Its return value is the caller's result
  // and the `output` of the `notes.save.completed` Event.
  execute(input: SaveNoteInput, context: ActionContext) {
    // Store the validated note. The Collection appends `note.created` to the
    // caller's operation before this call completes.
    return context.collections.note.create(
      // Only the note's own field. The runtime fills in `id`, `namespace` and
      // the timestamps.
      { text: input.text },
      // Collection keys are scoped to the running delivery, not to this call,
      // so prefix the write with this call's stable identity. Two calls in one
      // delivery make two writes; a retried call resolves to its stored note.
      { operationKey: `${context.operationKey}:save-note` },
    );
  },
});

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
      // The Action appends this Event when a call succeeds. `output` is the
      // value `execute` returned: here, the stored note.
      if (output.type === "notes.save.completed") {
        const { output: saved } = output.data as ActionCompletedData<
          SaveNoteInput,
          NoteRecord
        >;
        console.log(
          `event notes.save.completed id=${output.id} position=${output.position}`,
          `note=${saved.id} text=${JSON.stringify(saved.text)}`,
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

// The context `captureNote` expects. The third type parameter declares the
// Action callers it uses, so TypeScript checks their input and output. The
// runtime still passes the complete context; this type grants or hides nothing.
type CaptureContext = ProcessorContext<
  // Keep the default resource and adapter types.
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  // `context.actions.saveNote` calls the `notes.save` Action.
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Decides when a note is saved: once for every capture request, whoever sent
// it. The `notes.save` Action owns how a note is validated and stored.
const captureNote = defineProcessor<CaptureContext>({
  // Stable identity recorded on each delivery. Keep it once Events are stored.
  id: "notes.capture",
  // Match every Event of this type, in any namespace this application admits.
  on: [{ eventType: "notes.capture.requested" }],
  // Runs for the delivery the runtime selected for a matching Event, and may
  // run again for the same delivery on retry. Its default `inherit` settlement
  // makes the operation wait for this handler and for the Action it calls.
  async handle(event, context) {
    // Save notes only for stored requests, so every note traces back to a
    // recorded Event and its delivery.
    if (!event.durable) return;
    // Pass the request's resolved payload to the Action unchanged. The cast is
    // for TypeScript only: `notes.save` validates the data against its input
    // schema before it runs. The call resolves to the stored note, which this
    // Processor does not need.
    await context.actions.saveNote(
      event.data as SaveNoteInput,
      // Names this one call within the current delivery. A retried delivery
      // reuses the key and gets the recorded result instead of a second note.
      { operationKey: "save-request" },
    );
  },
});

// Compose an application with one Collection, one Action and one Processor.
// Omitting `database` gives this application a private in-memory database that
// lasts until the application closes or the process exits.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event and record this application owns.
  namespace: "team-notes",
  // Collections this application stores, keyed by the name Actions and
  // Processors use in `context.collections`.
  collections: { note },
  // Actions this application can run, keyed by the alias callers use in
  // `context.actions`. Lifecycle Events identify each one by its `id`.
  actions: { saveNote },
  // Processors this application runs, keyed by a local name. Copilotz
  // identifies each one by its `id`, not by this key.
  processors: { captureNote },
});

try {
  // Admit one named input. Copilotz commits it as a durable Event, records a
  // delivery for each matching Processor, and starts an operation that covers
  // that work, including the Action call and the note it stores.
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
  // Processor delivery, its Action call and the note write succeed. Wait for
  // both the reader and settlement before cleanup, even if either fails.
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

The sender is still unchanged: it sends `notes.capture.requested` and knows
nothing about the Action. The Processor decides when to save, the Action owns
how a note is saved, and the Collection owns the state and its facts.

If the input fails the Action's schema, the call is rejected before this
Action's lifecycle or `execute` starts, and it is not retried, so the delivery
fails at once. The `notes.capture.requested` input remains recorded; only the
Action call leaves nothing behind. `handle.done` rejects, the error propagates
after `close()` finishes, and the process exits with a non-zero status.

## Check it works

Run the entrypoint with a note of your own, using either runtime:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno run -A app.ts "Prepare the release."
# Node 24+: runs app.ts directly by stripping its type annotations.
node app.ts "Prepare the release."
```

The output has this shape. IDs and timestamps change on every run, and the
`notes.save.invoked` data is shortened here:

```text
accepted operation 3f6c… (input event 3f6c…)
event notes.capture.requested id=3f6c… position=1 data={"text":"Prepare the release."}
event notes.save.invoked id=7c42… position=2 data={…"actionId":"notes.save",…"input":{"text":"Prepare the release."},…}
event note.created id=8d2a… position=3 note=5b91… text="Prepare the release."
event notes.save.completed id=a1e0… position=4 note=5b91… text="Prepare the release."
settled operation 3f6c…: completed
```

Check these facts rather than the exact IDs, positions or line order:

- Exactly one `event notes.save.invoked` line appears, and its data shows
  `"actionId":"notes.save"` with the text you passed as its `input`.
- Exactly one `event note.created` line appears, with the text you passed.
- Exactly one `event notes.save.completed` line appears. Its `note=` value is
  the ID from the Action's `output`, and it equals the `note=` value on the
  `note.created` line: the Action returned the record it stored.
- Within this run, the `note.created` position is earlier than the
  `notes.save.completed` position. The write is committed before the Action call
  completes. Compare positions with each other, not with fixed values.
- The last line reports the operation state `completed`.

The script guarantees only that every Event in the operation's scope is printed
before `settled operation`. Other lines can interleave differently.

Now send an empty note to see the Action's input check:

```sh
# Deno: an empty string fails the `notes.save` input schema.
deno run -A app.ts ""
# Node 24+: the same check.
node app.ts ""
```

The Action rejects the input before its lifecycle or `execute` starts. The
`notes.capture.requested` input is still a recorded Event, but the call appends
no `notes.save.invoked`, `notes.save.completed` or failure Event, and no note is
stored, so no `note.created` line appears. `handle.done` rejects, the script
prints no `settled operation` line, and the process exits with a non-zero status
after closing the application. In Chapter 3 the same empty string was saved as a
note. Chapter 6 turns this check into an automated test.

## What this unlocks

Saving a note is now one named operation, separate from the code that triggers
it. You can:

- call `notes.save` from any code that receives the runtime context, and every
  caller gets the same input check and the same stored result;
- inspect each call's input, output and outcome through its `notes.save.*`
  lifecycle Events, which are part of the caller's operation;
- retry a caller safely, because each call is named within the running delivery
  and each write is named by its Action call's stable identity;
- add triggers later, such as an HTTP route or an agent tool, by deciding when
  they call the Action rather than copying its logic.

The [Actions reference](../../actions.md) covers output schemas, progress,
failure Events and secret inputs.

## Next steps

- Next: [Chapter 5: Package a Plugin](05-package-a-plugin.md) moves the
  Collection, the Action and the Processor out of `app.ts` into a reusable Notes
  plugin that does not depend on the agent harness.
- Reference: [Actions](../../actions.md) covers Action definitions, callers,
  lifecycle Events and validation.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains how deliveries, retries and operation keys keep repeated calls safe.
