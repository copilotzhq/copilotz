---
title: "Ch 3: Application Data and Actions"
description: "Store a note in a Collection and expose its save Action to an agent."
section: Getting Started
order: 30
status: stable
---

# Chapter 3: Application Data and Actions

> **Part 1 — Foundations**

## The pain

A tool can call code, but a product also needs application data and operations
that make sense outside one model call. If a note exists only in a tool result,
a person or another integration has nothing durable to read later.

## The smallest useful change

Define a Collection for notes and a save Action that writes to it. Then use
Core's positional `defineTool()` helper to give that Action a model-facing name
and description. The Action owns the operation; the Tool Resource tells an agent
when it may call it.

Create `notes-plugin.ts` at the project root:

```ts
// Import generic Action, Collection, and Plugin declarations from the runtime.
import {
  type ActionContext,
  defineAction,
  defineCollection,
  definePlugin,
} from "@copilotz/copilotz";
// Import Core's helper that presents an existing Action as a Tool Resource.
import { defineTool } from "@copilotz/copilotz/core";

// Define the durable application record for one saved note.
const note = defineCollection({
  // Name the Collection; its event types begin with this name.
  name: "note",
  // Validate each stored record with this JSON Schema.
  schema: {
    // Require note records to be JSON objects.
    type: "object",
    // Describe the stored fields and generated record ID.
    properties: {
      // Let the Collection runtime assign this read-only record identifier.
      id: { type: "string", readOnly: true },
      // Store the note text that the user or agent wants to keep.
      text: { type: "string" },
    },
    // Require every caller to supply the note text.
    required: ["text"],
  } as const,
});

// Define the reusable operation that creates one note record.
const saveNote = defineAction({
  // Give the Action a stable ID for its durable lifecycle events.
  id: "notes.save",
  // Validate the value accepted from an application caller or Tool call.
  inputSchema: {
    // Require the Action input to be a JSON object.
    type: "object",
    // Accept one non-empty text field.
    properties: { text: { type: "string", minLength: 1 } },
    // Require the text field before execution.
    required: ["text"],
    // Reject unrecognized Action input fields.
    additionalProperties: false,
  } as const,
  // Type the input and receive the composed runtime context for the write.
  async execute(input: Readonly<{ text: string }>, context: ActionContext) {
    // Create a Collection record; this key identifies the write within the Action.
    const saved = await context.collections.note.create(
      // Persist the text supplied to the Action.
      { text: input.text },
      // Give the Collection operation a stable name for retry recovery.
      { operationKey: "save-note" },
    );
    // Return the saved record as the Action result.
    return saved;
  },
});

// Present the Action to models using the same alias used by agent grants.
const saveNoteTool = defineTool("saveNote", saveNote, {
  // Name the capability as it should appear to the assistant.
  name: "Save note",
  // Describe when the model should choose this capability.
  description: "Save a short note for later reference.",
});

// Package the note data, operation, and agent presentation into one plugin.
export const notesPlugin = definePlugin({
  // Use a unique plugin identity for this application capability.
  id: "@example/notes",
  // Version the reusable declaration independently from the app.
  version: "1.0.0",
  // Register the durable note record type.
  collections: { note },
  // Register the Action that creates notes.
  actions: { saveNote },
  // Register the Action's model-facing Tool Resource.
  resources: { tools: { saveNote: saveNoteTool } },
});
```

Connect the plugin to the assistant from Chapter 1. Add this import:

```ts
// Import the statically declared notes capability from the project-root file.
import { notesPlugin } from "./notes-plugin.ts";
```

In `createCopilotz()`, add the plugin to the composition:

```ts
// Compose Core with the application-owned notes capability.
plugins: [corePlugin, notesPlugin],
```

In the assistant Resource, give it a note-taking role and the exact tool grant:

```ts
// Describe the assistant's note-taking purpose to the model.
role: "A helpful assistant that saves notes when asked.",
// Allow this assistant to call the note-saving Action through its Tool Resource.
capabilities: { tools: ["saveNote"] },
```

In the existing `message()` call, replace the `content` property with this
value, then run `assistant.ts` to ask the assistant to save a note:

```ts
// Ask the assistant to store a note through its granted saveNote capability.
content: "Save this note: review the launch checklist on Friday.",
```

Core routes the tool call to `saveNote`, and that Action creates a durable
Collection record. The same Action implementation belongs to your application
plugin, so another caller can reuse the operation through an application
interface.

## Breaking it down

Collections describe durable application state. Actions define operations with
recorded lifecycles. A Tool Resource is a presentation of an Action for an
agent; it does not replace the Action or the Collection.

This example uses only generic runtime declarations for the Collection, Action,
and plugin. It imports `defineTool()` from Core because the agent harness owns
that helper. The application runtime does not expose an `app.actions` method;
later chapters show how to invoke application behavior through composed
Processors and the server boundary.

## What this unlocks

- Notes have an application-owned record shape.
- Saving a note has one reusable Action implementation.
- Core can offer that Action to an agent without making application data
  exclusive to agents.

## What's next

A save also creates an immutable event. In
[Chapter 4: Processors and Lifecycles](./04-processors-and-lifecycles.md), react
to that fact and record a retry-safe audit row.
