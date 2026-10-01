---
title: "Ch 5: Reusable Plugins"
description: "Reuse the notes Action from a generic event Processor without an agent harness."
section: Getting Started
order: 50
status: stable
---

# Chapter 5: Reusable Plugins

> **Part 1 — Foundations**

## The pain

The assistant can save a note through a tool, but application behavior should
also work when a person or an integration starts it. Calling the same Action
through a different app-specific path should not require a second implementation
or an agent.

## The smallest useful change

Compose a small generic plugin that depends on `notesPlugin`. Its Processor
listens for a `notes.save.requested` input Event and invokes the existing
`saveNote` Action through the typed Processor context. This second app uses the
same Collection and Action without composing Core or making an LLM call.

Create `notes-worker.ts` beside `assistant.ts` and `notes-plugin.ts`:

```ts
// Import the generic application factory and plugin/Processor authoring APIs.
import {
  type ActionCallers,
  createCopilotz,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz";
// Reuse the note Action and Collections defined in the previous chapters.
import { notesPlugin } from "./notes-plugin.ts";

// Narrow the Processor context to the saveNote Action supplied by notesPlugin.
type NotesWorkerContext = ProcessorContext<
  // Keep the complete composed Resource namespace type.
  ProcessorContext["resources"],
  // Keep the complete composed Adapter namespace type.
  ProcessorContext["adapters"],
  // Expose only the Action caller this Processor needs.
  ActionCallers<{ saveNote: typeof notesPlugin.actions.saveNote }>
>;

// Turn a generic application Event into a call to the shared note Action.
const saveNoteOnRequest = defineProcessor<NotesWorkerContext>({
  // Give this durable event consumer a stable identity.
  id: "notes-worker.save-on-request",
  // Subscribe to the application's note-save request Event.
  on: [{ eventType: "notes.save.requested" }],
  // Validate through the Action and print its saved Collection record.
  async handle(event, context) {
    // Ignore a transient Event because this workflow expects a durable request.
    if (!event.durable) return;

    // Call the reusable Action with the request payload and a retry-stable key.
    const saved = await context.actions.saveNote(
      // Treat this event's application payload as the Action's declared input.
      event.payload as Readonly<{ text: string }>,
      // Derive Action identity from the request Event so a retry restores its result.
      { operationKey: "save-note-request:" + event.id },
    );
    // Print the record returned by the Action so this local example is visible.
    console.log("Saved note:", saved);
  },
});

// Package this Processor as a child plugin that reuses the notes plugin.
const notesWorkerPlugin = definePlugin({
  // Give the generic caller plugin its own stable identity.
  id: "@example/notes-worker",
  // Version this composition independently from the note capability.
  version: "1.0.0",
  // Compose the Action, Collections, and audit Processor from Chapter 4.
  plugins: [notesPlugin],
  // Register the generic event-to-Action workflow.
  processors: { saveNoteOnRequest },
});

// Create an application with the generic workflow and an in-memory database.
const app = await createCopilotz({
  // Route records to the same tenant namespace as the assistant example.
  namespace: "notes-demo",
  // Loading the child plugin also composes its notesPlugin dependency.
  plugins: [notesWorkerPlugin],
  // Keep this standalone demonstration local and disposable.
  database: { url: ":memory:" },
});

try {
  // Send a durable generic Event that asks the Processor to save a note.
  const request = await app.send({
    // The Processor subscribes to this application-defined Event type.
    type: "notes.save.requested",
    // Supply the input shape accepted by the saveNote Action.
    payload: { text: "The same Action works without an agent." },
  });

  // Wait for the request Processor, Action, and in-scope audit work to settle.
  await request.done;
} finally {
  // Release the application's in-memory runtime resources.
  await app.close();
}
```

Run the file with either supported host. It prints the record returned by
`saveNote`. No provider connection or API key is needed:

```sh
# Let Deno use its local PGlite/WASM and filesystem capabilities.
deno run -A notes-worker.ts
# Or run the ESM file with Node 24+ and the guide's PGlite dependency installed.
node notes-worker.ts
```

## Breaking it down

`notesWorkerPlugin` depends on `notesPlugin`, then contributes one Processor.
That dependency is static: composing the child also composes the note and audit
Collections and the save Action. The runtime does not discover files at startup.

The Processor context narrows `actions` with `ActionCallers`, so TypeScript
knows which Action the Processor may invoke. `app.send()` accepts the generic
Event envelope; this example does not use an `app.actions` surface. A server or
another integration can submit the same Event shape through its own boundary.

The request Event ID is stable across a retry of that delivery. The Processor
uses it in the Action operation key; the Action then uses its Collection
operation key for the note write. Chapter 6 explains what those identities do
and which external side effects still need their own idempotency support.

If the declarations later spread across many files, convention-first authoring
can generate the same static plugin composition at build time. See
[Convention-first authoring](../../convention-authoring.md); the running
application still imports the generated module rather than scanning source
files.

## What this unlocks

- The same save Action works through Core for an agent and through a generic
  Processor for other application callers.
- Collection mutations and follow-up work keep one shared lifecycle.
- Applications can add an agent harness only where they need one.

## What's next

The note and audit records currently live only as long as the in-memory
application. In
[Chapter 6: Persistence and Recovery](./06-persistence-and-recovery.md), keep
them across restarts and learn where retry guarantees end.
