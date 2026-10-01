---
title: "Ch 4: Processors and Lifecycles"
description: "React to note creation with a durable Processor and an idempotent audit record."
section: Getting Started
order: 40
status: stable
---

# Chapter 4: Processors and Lifecycles

> **Part 1 — Foundations**

## The pain

Saving a note is one operation. A product may also need to record that it
happened, notify another component, or start follow-up work. Adding all of that
inside every caller would make the feature harder to reuse.

## The smallest useful change

Add a Processor that listens for the Collection's `note.created` event and
writes an audit record to another Collection. The event ID supplies a stable
identity for both the audit row and its Collection operation key, so a retried
delivery can recover the same write.

Add these imports near the top of `notes-plugin.ts`:

```ts
// Import the generic Processor declaration and the context type from plugin authoring.
import { defineProcessor, type ProcessorContext } from "@copilotz/copilotz";
```

Add the audit Collection alongside the existing `note` Collection:

```ts
// Define one durable audit row for a note-created Event.
const noteAudit = defineCollection({
  // Name the Collection and its generated event family.
  name: "note_audit",
  // Validate the audit data that the Processor writes.
  schema: {
    // Store audit records as JSON objects.
    type: "object",
    // Describe the audit identity and its source relationship.
    properties: {
      // Use the source Event ID to keep this audit row stable on retry.
      id: { type: "string", readOnly: true },
      // Point to the note record that was created.
      noteId: { type: "string" },
      // Keep the immutable Event that caused this row.
      sourceEventId: { type: "string" },
    },
    // Require both references for a meaningful audit record.
    required: ["noteId", "sourceEventId"],
  } as const,
});
```

Add this Processor after the existing `saveNoteTool` declaration:

```ts
// Subscribe to note creation so audit behavior stays separate from save callers.
const auditNoteCreated = defineProcessor<ProcessorContext>({
  // Give this durable event consumer a stable identity.
  id: "notes.audit-note-created",
  // Match only created Events whose subject is a note record.
  on: [{ eventType: "note.created", subject: { type: "note" } }],
  // Write an audit Collection record using the composed runtime context.
  async handle(event, context) {
    // Ignore transient Events or Events without the expected subject.
    if (!event.durable || event.subject?.type !== "note") return;

    // Record the source Event and note under IDs derived from that Event.
    await context.collections.noteAudit.create(
      // Use the Event ID so a replay addresses the same audit record.
      {
        id: "event-" + event.id,
        noteId: event.subject.id,
        sourceEventId: event.id,
      },
      // Reuse a stable operation key if this Processor delivery retries.
      { operationKey: "note-audit:" + event.id },
    );
  },
});
```

In the existing `notesPlugin` definition, replace its `collections` property and
add a `processors` property:

```ts
// Keep the note Collection and register the new audit Collection.
collections: { note, noteAudit },
// Register the Processor that reacts to note-created Events.
processors: { auditNoteCreated },
```

The rest of `notes-plugin.ts` stays as it was, including its exported
`notesPlugin`. When the assistant saves a note, the Collection emits
`note.created`; the Processor writes an audit row and its own
`note_audit.created` Event.

## Breaking it down

A Processor receives a matched Event and the composed runtime context. It does
not need a database handle or a private storage service: it writes through the
declared `noteAudit` Collection.

The Processor uses both a stable record ID and a stable operation key derived
from the source Event ID. This makes its built-in Collection write replay-safe.
The Processor itself may execute more than once, so external side effects such
as sending an email still need an idempotency mechanism at the service that owns
that side effect.

## What this unlocks

- Follow-up behavior can be added without changing `saveNote` or its callers.
- The application keeps an auditable record of the note-creation fact.
- The same event-driven pattern can coordinate larger workflows.

## What's next

The two Collections, Action, Tool Resource, and Processor form a reusable
application capability. In
[Chapter 5: Reusable Plugins](./05-reusable-plugins.md), organize and compose
that capability without adding runtime filesystem discovery.
