---
title: "Plugins and Processors"
description: "Compose Collections, Actions and Processors into plugins, and write Processors that react to Events safely under retries, settlement and terminal failure."
section: Runtime
order: 10
status: stable
---

# Plugins and Processors

## The pain

Notes works in one application. Then a second team wants an import feature that
reuses `notes.save`, a test suite wants to compose Notes without the importer,
and the importer occasionally receives malformed rows. Without clear rules, the
importer copies the `note` Collection, two plugins both register an alias called
`saveNote`, and one bad row retries until it dead-letters silently with no
record a user can see.

## The problem

Reuse needs a composition contract and reactions need a delivery contract:

- Which names are stored identities, which are lookup aliases, and what happens
  when two packages declare the same one?
- How does a reaction call shared Actions with checked types, read the Event
  safely and stay correct when it runs more than once?
- When a reaction can never succeed, how does the application record that
  outcome instead of leaving only a dead-lettered delivery?

## The solution

A **Plugin**, declared with `definePlugin`, is plain data: an `id`, a `version`,
optional dependency `plugins` and keyed maps of `collections`, `actions`,
`processors`, `resources` and `adapters`. Defining one opens nothing.
`createCopilotz({ plugins })` registers its contents.

A **Processor**, declared with `defineProcessor`, is a subscription: its `on`
clauses select Events and `handle(event, context)` reacts to them. For a durable
Event, the runtime records a delivery and runs the handler at least once until
that delivery settles. Live Events are handled best effort: nothing is recorded,
retried or recovered, so durable side effects belong behind the `event.durable`
guard.

### Composition rules

- **Dependencies first.** Each plugin's `plugins` are registered before its own
  maps, depth first. The application's own `collections`, `actions`,
  `processors`, `resources` and `adapters` passed to `createCopilotz` act as a
  final root plugin registered after every listed plugin.
- **Same object, registered once.** When several plugins depend on the same
  plugin object, it is registered once. A _different_ object with the same
  plugin `id` fails composition with
  `Plugin '<id>' was declared more than once.` Dependency cycles also fail.
- **Aliases and IDs are both unique.** Map keys are aliases. Each alias may
  appear once per kind across the whole composition, and each stable ID
  (Collection `name`, Action `id`, Processor `id`) may be exposed under only one
  alias. The application's root maps take part in the same checks: they cannot
  replace a plugin's Collection, Action or Processor. Declaring a root Action
  under an alias a plugin already uses fails with
  `Action alias '<alias>' is declared by more than one plugin.`
- **Resources and adapters overlay.** `resources` and `adapters` are
  `{ namespace: { alias: value } }` maps merged by key in registration order. A
  later value for the same namespace and alias replaces an earlier one, so
  values the application passes to `createCopilotz` win.

Aliases are lookup names: `context.collections.note` and
`context.actions.saveNote(...)`. A Processor alias is only a composition key;
Processors are never exposed on the context, and stored deliveries find them by
their stable `id`.

### Processor rules

- **Matching.** Each `on` entry is an alternative; fields inside one entry
  (`eventType`, `namespace`, `subject`, `metadata`, `data`) must all match. A
  static `eventType: "*"` is rejected unless the entry also has a non-empty
  `subject`, `metadata` or `data` matcher. Checks that depend on changing state
  belong in `handle`.
- **The Event.** Read `event.data`, the resolved Event data, not the admitted
  request payload. Guard with `if (!event.durable) return;` before using
  `event.id` or data that must trace back to a stored Event.
- **Typed callers.** The context is the complete composed runtime context. Its
  type parameters only describe it for TypeScript; they grant or hide nothing.
  Declare the Actions a Processor calls with `ActionCallers` as the **third**
  type parameter of `ProcessorContext`.
- **Retries.** A thrown error fails the attempt and the delivery retries with
  bounded backoff. Give each Collection write and Action call an `operationKey`
  you choose as its retry identity: a stable name per distinct step, so a retry
  resolves to the recorded result instead of repeating it. External side effects
  need their own service-side idempotency. For a defect that cannot heal, throw
  `markNonRetryable(error)` from `@copilotz/copilotz/plugins`; the delivery
  stops retrying at once. Do not treat broad classes such as `TypeError` as
  permanent by themselves.
- **Terminal failure.** Optional `onError(error, event, context)` runs only when
  a durable handler error is terminal: attempts are exhausted or the error is
  non-retryable. It runs under the same lease and context, and never after
  cancellation or lease loss. Return `true` only after persisting the domain
  failure outcome; the delivery is then acknowledged as handled. Returning
  `false`, or throwing, leaves it dead-lettered. A crash before acknowledgement
  can replay both handler and hook, so key their writes too.
- **Settlement.** The default `settlement: "inherit"` makes the triggering
  operation wait for the delivery and its Action calls. `"detached"` keeps the
  work durable but does not delay or fail the foreground operation.
- **Cleanup.** `context.signal` aborts when the attempt is cancelled or loses
  its lease. Pass it to long waits and release anything the handler opened in a
  `finally` block.

### Example: an importer that depends on Notes

This example reuses `notes-plugin.ts` from
[Chapter 5](getting-started/part-1-design-and-build/05-package-a-plugin.md)
unchanged; place it in the same directory. Install the runtime package first:

```sh
# Deno
deno add jsr:@copilotz/copilotz@^0.84.4
# Node 24+
npx jsr add @copilotz/copilotz@^0.84.4
```

Create `notes-import-plugin.ts`. It is a pure definition module: no environment,
no I/O on import.

```ts
// Declaration helpers from the portable runtime package.
import {
  defineCollection,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Context types for the Processor and the Action callers it uses.
import type { ActionCallers, ProcessorContext } from "@copilotz/copilotz";
// Marks a failure that retrying cannot fix.
import { markNonRetryable } from "@copilotz/copilotz/plugins";
// The shared Notes package and its exported Action.
import { notesPlugin, saveNote } from "./notes-plugin.ts";

// One record per import row that could not become a note, so the outcome is
// visible application state rather than only a dead-lettered delivery.
export const importFailure = defineCollection({
  name: "note_import_failure",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", readOnly: true },
      // The import request Event that failed.
      eventId: { type: "string" },
      // A fixed, user-facing explanation chosen by the application.
      reason: { type: "string" },
    },
    required: ["eventId", "reason"],
  } as const,
});

// The Action callers this Processor uses, as the third type parameter.
type ImportContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Turns each `notes.import.requested` row into a note through `notes.save`.
export const importNote = defineProcessor<ImportContext>({
  id: "notes.import",
  on: [{ eventType: "notes.import.requested" }],
  async handle(event, context) {
    // Only stored requests create notes.
    if (!event.durable) return;
    // Resolved Event data, not the raw admitted payload. Generic ingress can
    // send null, arrays or other shapes, so check before reading a field.
    const data = event.data;
    const text = data !== null && typeof data === "object" &&
        !Array.isArray(data)
      ? (data as { text?: unknown }).text
      : undefined;
    if (typeof text !== "string" || text.length === 0) {
      // A malformed row stays malformed: skip retries.
      throw markNonRetryable(new TypeError("Import row has no note text."));
    }
    // Chosen retry identity: a retried delivery gets the recorded note, not a
    // second one.
    await context.actions.saveNote(
      { text },
      { operationKey: "save-import" },
    );
  },
  // Runs only for a terminal handler error. Persist the outcome, then
  // acknowledge it by returning true.
  async onError(_error, event, context) {
    // The runtime calls this only for durable deliveries; the guard narrows the
    // type before `event.id` is read.
    if (!event.durable) return false;
    await context.collections.note_import_failure.create(
      {
        eventId: event.id,
        // A fixed message. Raw error text can carry provider, SQL or secret
        // details, so it does not belong in a user-visible record.
        reason: "This row could not be imported as a note.",
      },
      // Keyed so a replay after a crash finds the stored failure.
      { operationKey: "record-import-failure" },
    );
    return true;
  },
});

// Depends on the same `notesPlugin` object other packages use, so Notes is
// registered once however many plugins depend on it.
export const notesImportPlugin = definePlugin({
  id: "@team-notes/import",
  version: "1.0.0",
  plugins: [notesPlugin],
  collections: { note_import_failure: importFailure },
  processors: { importNote },
});
```

Create `import.ts`, a small entrypoint that sends one valid and one malformed
row:

```ts
// Runtime factory.
import { createCopilotz } from "@copilotz/copilotz";
// The shared Notes package and the importer that depends on it.
import { notesPlugin } from "./notes-plugin.ts";
import { notesImportPlugin } from "./notes-import-plugin.ts";

// Listing `notesPlugin` again is harmless: it is the same object, so it is
// registered once. Omitting `database` uses a private in-memory database.
const app = await createCopilotz({
  namespace: "team-notes",
  plugins: [notesPlugin, notesImportPlugin],
});

try {
  for (const payload of [{ text: "Ship the importer." }, { text: "" }]) {
    const handle = await app.send({ type: "notes.import.requested", payload });
    // Print durable Event types while waiting for settlement.
    const print = (async () => {
      for await (const output of handle.outputs) {
        if ("durable" in output && output.durable) console.log(output.type);
      }
    })();
    await Promise.all([print, handle.done]);
    console.log("settled", JSON.stringify(payload));
  }
} finally {
  // Release the runtime and its database, including after a failure.
  await app.close();
}
```

Run it with `deno run -A import.ts` or `node import.ts`. The first row prints
`notes.save.invoked`, `note.created` and `notes.save.completed`. The second
prints `note_import_failure.created` and no `notes.save.*` Events. Both
operations settle, because `onError` recorded the failure and returned `true`.
Remove `onError` and the second `handle.done` rejects instead: the delivery is
dead-lettered after the non-retryable error.

## What this unlocks

- Build packages on shared plugins without copying them, and get a clear
  composition error instead of a silent replacement.
- Call Actions from reactions with checked input and output types.
- Turn permanent failures into application state that users and operators can
  query.

## Next steps

- [Actions](actions.md) covers Action definitions, invocation keys and prepared
  calls.
- [Collections](collections.md) covers schemas, scoped writes and mutation
  Events.
- [Events, deliveries and recovery](events-deliveries-recovery.md) explains
  delivery states, leases and diagnostics for failed Processors.
