---
title: "Chapter 5: Package a Plugin"
description: "Move the note Collection, the notes.save Action and the notes.capture Processor into a reusable Notes plugin, and keep the application's own choices in one host composition module."
section: Getting Started
order: 50
status: stable
---

# Chapter 5: Package a Plugin

> Part 1 — Design and Build · Track: R · Requires: Chapter 4 · Needs: Deno 2.9+
> or Node 24+ (no credential)

## The pain

At the end of Chapter 4, `app.ts` holds everything: the `note` Collection, the
`notes.save` Action, the `notes.capture` Processor, the namespace, the database
choice, the code that sends a request and the code that prints the results.

The next callers are already on the way. A test suite, an HTTP server, a
scheduled job and an agent tool all need the same Notes behaviour. None of them
can import it from `app.ts`, because importing that file runs it: it sends a
capture request and closes the application. Copying the declarations into each
caller would give several `note` Collections that slowly drift apart, while all
of them claim the same `note` name and the same `notes.save` ID.

## The problem

Two kinds of decision are mixed together in one file:

- **Domain behaviour** is what Notes _is_: the shape of a note, how a note is
  validated and saved, and which request triggers a save. It should be written
  once and shared by every caller.
- **Host choices** belong to one application: which tenant namespace it records,
  which database it opens and which packages it composes. A test, a server and a
  command-line script may each choose differently.

The domain behaviour also has to be safe to import anywhere, including into
tests and other applications' compositions. An entrypoint such as `app.ts` runs
work when it executes, and live host configuration may connect to outside
services, so neither can be that pure, shareable boundary.

## The solution

Package the domain behaviour as a **Plugin**: a named, versioned bundle of
Collections, Actions and Processors, declared with `definePlugin`. A Plugin is
plain data. Defining it opens no database and starts nothing. An application
composes it by listing it under `plugins` in `createCopilotz`, and the runtime
registers its contents exactly as if they had been passed directly.

This chapter splits `app.ts` into three files, one per module role:

| File              | Role             | Holds                                         |
| ----------------- | ---------------- | --------------------------------------------- |
| `notes-plugin.ts` | Definition       | The Notes declarations and `notesPlugin`      |
| `composition.ts`  | Host composition | The namespace, database and plugin list       |
| `app.ts`          | Entrypoint       | Sending one request and printing what happens |

The declarations move unchanged. Every stable identity stays the same: the
`note` Collection name, the `notes.save` Action ID, the `notes.capture`
Processor ID, the schemas and both operation keys. The runtime therefore records
the same Events with the same lifecycle and the same validation as in Chapter 4.

A Plugin has its own names, and so does everything inside it:

- **The plugin `id`**, here `@team-notes/notes`, identifies the package within
  one application. `version`, here `1.0.0`, records which release of the package
  this is.
- **Stable IDs** are part of stored data: the Collection `name` (`note`), the
  Action `id` (`notes.save`) and the Processor `id` (`notes.capture`). Event
  types are built from them, so keep them unchanged once Events are stored.
- **Composition aliases** are the keys of the plugin's `collections`, `actions`
  and `processors` maps: `note`, `saveNote` and `captureNote`. The Collection
  and Action aliases are also lookup names at run time, as in
  `context.collections.note` and `context.actions.saveNote(...)`. A Processor
  alias is only a local composition key: code never calls a Processor through
  the context, and stored deliveries find it by its stable ID, `notes.capture`.
  Aliases are shared across the whole composed application. If two plugins
  declare the same alias, or expose the same stable ID under two aliases,
  composition fails instead of letting one silently replace the other.

Plugins can also depend on other plugins by listing them under their own
`plugins` key. When several plugins depend on the same `notesPlugin` object,
Copilotz registers it once, so every caller shares one `note` Collection and one
`notes.save` Action. A different plugin object that reuses the
`@team-notes/notes` ID is rejected rather than merged. Later chapters build on
this: an agent tool wraps the exported `saveNote` Action, and a scheduled digest
depends on `notesPlugin` instead of copying it.

The Plugin declares no namespace and no database. Those are the application's
choices, so they move into `composition.ts`: one shared choice for the host
entrypoints that run Notes, not a file every Copilotz application needs.

### Create `notes-plugin.ts`

`notes-plugin.ts` is a **definition module**. It declares the Notes behaviour
and the plugin that packages it. It reads no environment, performs no I/O when
imported, and imports only the portable runtime package, never the agent
harness. That keeps it safe to import from tests, servers and later plugins.

The declarations are the ones from Chapter 4, now exported. `saveNote` is
exported on its own as well as inside the plugin so that a later wrapper can
refer to the same Action definition without copying it. The `NoteRecord` and
`SaveNoteInput` types are exported for callers that read the results.

```ts
// Helpers that declare a Collection, an Action, a Processor and the Plugin
// that packages them. All of them come from the portable runtime package.
import {
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Types of the contexts that the Action and the Processor receive, and of the
// Action callers that the Processor expects.
import type {
  ActionCallers,
  ActionContext,
  ProcessorContext,
} from "@copilotz/copilotz";

// Application state for captured notes. Every record is checked against this
// schema before it is stored, and every change appends a `note.*` Event.
export const note = defineCollection({
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

// Shape of one stored note, derived from the Collection's schema. Callers use
// it to read `note.created` Events and the Action's output.
export type NoteRecord = typeof note.$inferSelect;

// Input that callers pass to `notes.save`. TypeScript checks calls against this
// type; the Action's `inputSchema` enforces the same shape at run time.
export type SaveNoteInput = { text: string };

// Reusable, validated operation that stores one note. It runs only when a
// caller invokes it, and each call records its own lifecycle Events.
export const saveNote = defineAction({
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
export const captureNote = defineProcessor<CaptureContext>({
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

// The Notes package: everything an application needs to capture and store
// notes, with no namespace, database or entrypoint of its own.
export const notesPlugin = definePlugin({
  // Identifies this package within one composed application. Another plugin
  // object with the same ID is rejected rather than merged.
  id: "@team-notes/notes",
  // Records which release of the package this is.
  version: "1.0.0",
  // Keyed by the alias that Actions and Processors use in
  // `context.collections`. The stored identity is the Collection's `name`.
  collections: { note },
  // Keyed by the alias that callers use in `context.actions`. Lifecycle Events
  // identify the Action by its `id`, `notes.save`.
  actions: { saveNote },
  // Keyed by a local name. Deliveries identify the Processor by its `id`,
  // `notes.capture`.
  processors: { captureNote },
});
```

### Create `composition.ts`

`composition.ts` is a **host composition module**. It records the choices that
belong to this application rather than to the Notes package. The host
entrypoints that run Notes, starting with `app.ts`, import these values instead
of repeating them. Chapter 8's first agent runs on its own without Notes;
Chapter 9 brings the agent onto these same choices. This module needs no
credential yet, so it reads no environment and performs no I/O when imported.

```ts
// The database options type, so a mistyped option fails type-checking here
// rather than at startup.
import type { CopilotzOminipgOptions } from "@copilotz/copilotz";
// The reusable Notes package. The application composes it; it does not copy it.
import { notesPlugin } from "./notes-plugin.ts";

// Tenant namespace recorded on every Event and record this application owns.
// It is the application's choice, so the plugin does not declare one.
export const namespace = "team-notes";

// The database that the Notes host entrypoints open. `:memory:` names the
// private in-memory database Copilotz already uses when `database` is omitted,
// so this changes no behaviour and is not required setup. It is written down
// once so that those entrypoints share one choice: Chapter 7 changes only this
// entry to keep notes across restarts.
export const database: CopilotzOminipgOptions = { url: ":memory:" };

// Runtime plugins this application composes, in order. Later chapters append to
// this list, so each Notes entrypoint gains new behaviour without dropping it.
export const runtimePlugins = [notesPlugin];
```

Tests are a different host with different needs. Chapter 6 imports `notesPlugin`
directly and composes its own in-memory application, without importing
`composition.ts`.

### Edit `app.ts`

`app.ts` stays an **entrypoint** and needs no new package or credential. This
step replaces the whole file:

1. It removes the Collection, Action and Processor declarations, which now live
   in `notes-plugin.ts`.
2. It imports `namespace`, `database` and `runtimePlugins` from
   `composition.ts`, and the `NoteRecord` and `SaveNoteInput` types from
   `notes-plugin.ts`.
3. It replaces the `collections`, `actions` and `processors` maps in
   `createCopilotz` with `plugins: runtimePlugins`, and passes the namespace and
   database choices.

`printOutputs`, the request it sends and the settlement handling are unchanged.

The complete updated file:

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of each output item and of the data that Collection and Action Events
// hold.
import type {
  ActionCompletedData,
  ApplicationOutput,
  CollectionCreated,
} from "@copilotz/copilotz";
// The application's own choices, shared by the entrypoints that run Notes.
import { database, namespace, runtimePlugins } from "./composition.ts";
// Types of a stored note and of the Action's input, for reading results.
import type { NoteRecord, SaveNoteInput } from "./notes-plugin.ts";
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

// Compose the application from its host choices. The Notes plugin contributes
// the `note` Collection, the `notes.save` Action and the `notes.capture`
// Processor under the same aliases and IDs as before.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event and record this application owns.
  namespace,
  // The shared database choice. Closing the application releases it.
  database,
  // Plugins to compose. Their Collections, Actions and Processors are
  // registered as if they had been passed directly.
  plugins: runtimePlugins,
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
  // Processor delivery, its Action call and the note write succeed, and
  // Promise.all rejects as soon as either side fails.
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

The entrypoint now says only what this run does: compose the application's
choices, send one request and report what happened. It knows the Notes Event
types it prints, but not how a note is validated or stored.

Failures behave as in Chapter 4. If the input fails the Action's schema, the
delivery fails at once, `handle.done` rejects, the error propagates after
`close()` finishes, and the process exits with a non-zero status. If composition
itself fails, for example because two plugins declare the same alias,
`createCopilotz` rejects before any request is sent and the process exits with a
non-zero status.

## Check it works

Run the entrypoint with a note of your own, using either runtime. Both resolve
the local `./composition.ts` and `./notes-plugin.ts` imports from the same
directory as `app.ts`:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno run -A app.ts "Prepare the release."
# Node 24+: runs app.ts and its local .ts imports by stripping type annotations.
node app.ts "Prepare the release."
```

The output has the same shape as in Chapter 4. IDs and timestamps change on
every run, and the `notes.save.invoked` data is shortened here:

```text
accepted operation 3f6c… (input event 3f6c…)
event notes.capture.requested id=3f6c… position=1 data={"text":"Prepare the release."}
event notes.save.invoked id=7c42… position=2 data={…"actionId":"notes.save",…"input":{"text":"Prepare the release."},…}
event note.created id=8d2a… position=3 note=5b91… text="Prepare the release."
event notes.save.completed id=a1e0… position=4 note=5b91… text="Prepare the release."
settled operation 3f6c…: completed
```

Check the same facts as in Chapter 4, rather than the exact IDs, positions or
line order:

- Exactly one `event notes.save.invoked` line appears, and its data shows
  `"actionId":"notes.save"` with the text you passed as its `input`.
- Exactly one `event note.created` line appears, with the text you passed.
- Exactly one `event notes.save.completed` line appears, and its `note=` value
  equals the `note=` value on the `note.created` line.
- Within this run, the `note.created` position is earlier than the
  `notes.save.completed` position.
- The last line reports the operation state `completed`.

The Event types are unchanged because the stable IDs are unchanged: packaging
the declarations did not rename anything that is recorded.

Now send an empty note to confirm that validation moved with the Action:

```sh
# Deno: an empty string still fails the `notes.save` input schema.
deno run -A app.ts ""
# Node 24+: the same check.
node app.ts ""
```

As in Chapter 4, the `notes.capture.requested` input is recorded, but no
`notes.save.invoked`, `notes.save.completed` or `note.created` line appears and
no `settled operation` line is printed. The process exits with a non-zero status
after closing the application.

## What this unlocks

Notes is now one package with one implementation, and the application's choices
live in one place. You can:

- compose the same `notesPlugin` into any host, such as a test, an HTTP server
  or a scheduled worker, and every host gets the same validation, lifecycle
  Events and retry safety;
- build later plugins on top of Notes by depending on `notesPlugin`, knowing
  that a shared dependency is registered once;
- wrap the exported `saveNote` Action for another caller, such as an agent tool,
  without copying its logic;
- change a host choice, such as the database, once in `composition.ts` for every
  entrypoint that runs Notes.

The [Plugins and Processors reference](../../plugins-and-processors.md) covers
composition order, dependency rules, alias conflicts, and how application
resources and adapters overlay plugin values.

## Next steps

- Next:
  [Chapter 6: Test and Inspect](../part-2-verify-and-recover/06-test-and-inspect.md)
  composes `notesPlugin` in an in-memory test and checks its Events
  automatically on Deno and Node.
- Optional:
  [Chapter 8: Hello Agent](../part-3-add-agent-behavior/08-hello-agent.md)
  starts the agent-harness track. It needs only setup, so you can try it now and
  return to Chapter 6 afterwards.
- Reference: [Plugins and Processors](../../plugins-and-processors.md) explains
  plugin definitions, dependencies and composition rules in detail.
