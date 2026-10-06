---
title: "Chapter 9: Grant Tools"
description: "Present the existing notes.save Action to the assistant as a granted tool, add a built-in clock tool, and run the agent on the application's Notes composition."
section: Getting Started
order: 90
status: stable
---

# Chapter 9: Grant Tools

> Part 3 — Add Agent Behavior · Track: H · Requires: Chapters 5 and 8 · Needs:
> Deno 2.9+ or Node 24+, and an `OPENAI_API_KEY` for the live example

## The pain

The assistant from Chapter 8 can talk about notes, but it cannot save one. Ask
it to "save a note saying Prepare the release" and it replies with friendly
text, while the `note` Collection stays empty.

The obvious fix is to write a second save function for the model: parse its
reply, check the text, write a record. That copy would skip the `notes.save`
input schema, its lifecycle Events and its retry-safe operation key. Then a note
saved by the agent and a note saved by `app.ts` would follow different rules.

## The problem

A model needs two things before it can use an operation: a **presentation** it
can read (a name, a description and the input shape), and **permission** to use
it. Neither of those should change how the operation behaves. Saving a note is
already defined, validated and recorded once, as the `notes.save` Action in
`notesPlugin`.

There is also a composition gap. Chapter 8's `chat.ts` runs on its own: it uses
the same `team-notes` namespace, but composes no Notes plugin and opens its own
private in-memory database instead of the application's database choice. The
agent cannot save into a Collection that its application does not compose.

## The solution

A **Tool** is the model-facing presentation of an ordinary Action. It is plain
data: the alias of the Action to run, a name and a description, and the Action's
input and output schemas copied from its definition. When the model calls the
tool, Core invokes that Action through the normal runtime, so the call is
validated against the same input schema and records the same Events as any other
caller.

Registering a Tool does not let any agent use it. An agent uses a tool only when
its `capabilities.tools` list **grants** the tool's alias.

This chapter changes four files:

| File             | Role             | Change                                    |
| ---------------- | ---------------- | ----------------------------------------- |
| `notes-tools.ts` | definition       | new: the `saveNote` Tool and its plugin   |
| `assistant.ts`   | definition       | grants two tools and adds instructions    |
| `agent.ts`       | host composition | adds the tool plugin and the clock tool   |
| `chat.ts`        | entrypoint       | runs on `composition.ts` and prints Notes |

`notes-plugin.ts`, `composition.ts`, `app.ts` and the Chapter 6 tests do not
change. The Notes package stays free of Core, `app.ts` still runs without it,
and the tests still compose only `notesPlugin` in memory.

No new package is needed, and the credential is the same `OPENAI_API_KEY` from
Chapter 8.

### Create `notes-tools.ts`

`notes-tools.ts` is a **definition module**. It reads no environment and does no
I/O when imported. It is a separate file, rather than an addition to
`notes-plugin.ts`, because `defineTool` comes from Core: keeping it here lets
runtime-only hosts keep importing Notes without the agent harness.

`defineTool("saveNote", saveNote, presentation)` takes three arguments: the
alias under which the Action is registered, the Action definition, and the
presentation. It copies the Action's schemas into the Tool and returns plain
data. It does not register or run the Action. The Action itself comes from
`notesPlugin`, which this plugin lists as a dependency.

```ts
// Declares the plugin that packages the tool.
import { definePlugin } from "@copilotz/copilotz";
// Core's helper that presents an existing Action to models.
import { defineTool } from "@copilotz/copilotz/core";
// The Notes package and the Action the tool presents, reused unchanged.
import { notesPlugin, saveNote } from "./notes-plugin.ts";

// The model-facing view of `notes.save`. The first argument is the alias that
// `notesPlugin` registers the Action under; Core calls that Action when the
// model uses this tool. Its input and output schemas are copied from `saveNote`.
export const saveNoteTool = defineTool("saveNote", saveNote, {
  // Short human-readable name shown with the tool.
  name: "Save note",
  // Tells the model what the tool does and when to use it.
  description:
    "Save one note with the given text to the team's notes. Use it only when the user asks to save or record a note.",
});

// Packages the tool. Depending on `notesPlugin` guarantees that the `saveNote`
// Action the tool points to is composed wherever this plugin is.
export const notesToolsPlugin = definePlugin({
  // Identifies this package within one composed application.
  id: "@team-notes/notes-tools",
  // Records which release of the package this is.
  version: "1.0.0",
  // Composed before this plugin. The same `notesPlugin` object listed again by
  // the application is registered once, not twice.
  plugins: [notesPlugin],
  // Tool resources, keyed by the alias that agents grant.
  resources: {
    tools: { saveNote: saveNoteTool },
  },
});
```

The dependency matters in `chat.ts` below. The application lists `notesPlugin`
through `runtimePlugins`, and `notesToolsPlugin` lists the same object again.
Because both refer to the identical object, Copilotz registers it once, with one
`note` Collection and one `notes.save` Action. A _different_ plugin object with
the `@team-notes/notes` ID would make composition fail instead.

### Edit `assistant.ts`

`assistant.ts` stays a pure definition. Make two additive edits to the
`assistant` object:

1. **Add** the following guidance to `instructions`, creating that property
   after `role` when absent. When the property already has instructions, append
   these sentences to its existing string.
2. **Append** `saveNote` and `get_current_time` to `capabilities.tools`, keeping
   every existing tool grant. Leave `capabilities.agents` and
   `capabilities.skills` unchanged.

```ts
// Guidance on when to use the new tools, in addition to existing instructions.
instructions:
  "When the user explicitly asks you to save or record a note, call the saveNote tool with the note text. When the user asks for the time or date, call the get_current_time tool. Do not save notes the user did not ask for.",
```

Starting from Chapter 8 alone, the resulting tool list is:

```ts
// Aliases of the Notes tool and the built-in clock.
tools: ["saveNote", "get_current_time"],
```

These are aliases, the keys under `resources.tools`. They are not the Action IDs
(`notes.save`) or the presentation names (`Save note`). Keep any Memory grants
already in the list, and any Skills or specialist grants in the other lists.

### Edit `agent.ts`

`agent.ts` stays the host composition module. Shared files may already contain
Skills, specialists or Memory, so these named edits preserve those additions
instead of replacing the whole file.

**Insert** these imports after the existing `corePlugin` import:

```ts
// Built-in clock tool. It carries its own Action, which composition installs.
import { getCurrentTimeToolResource } from "@copilotz/copilotz/tools/builtin";
// The Notes tool, packaged with its dependency on the Notes plugin.
import { notesToolsPlugin } from "./notes-tools.ts";
```

**Append** `notesToolsPlugin` to `agentPlugins`, keeping every plugin already
there. Starting from Chapter 8 alone, the result is:

```ts
// Core and the package that presents the Notes Action to models.
export const agentPlugins = [corePlugin, notesToolsPlugin];
```

**Add** `get_current_time: getCurrentTimeToolResource` to
`agentResources.tools`. Create the `tools` map when absent; keep every other
entry in it and every other resource map. The baseline map is:

```ts
// Host-chosen tools, keyed by the aliases agents grant.
tools: {
  // The clock's resource carries the Action to install under this alias.
  get_current_time: getCurrentTimeToolResource,
},
```

Keep the credential check, the `openai` connection and all entries in
`agentResources.agents` unchanged. `getCurrentTimeToolResource` carries its own
Action: composition installs it under the same alias and turns the resource into
a Tool, so no additional plugin is needed. The assistant's grant controls
whether it may use the clock.

### Edit `chat.ts`

`chat.ts` stays an entrypoint. It now uses the application's Notes host choices
and prints Notes facts alongside the reply. These named edits preserve any Skill
or Memory diagnostics already added to the reader.

Add the following imports after the existing `./agent.ts` import. When `chat.ts`
already imports `database` and `namespace` from `./composition.ts`, **extend
that import** with `runtimePlugins` instead of declaring those bindings again.
Otherwise, **insert** the complete composition import below. Insert the new type
imports in either case:

```ts
// The application's own choices, shared with app.ts.
import { database, namespace, runtimePlugins } from "./composition.ts";
// Types of the recorded Collection and Action outcomes this reader prints.
import type {
  ActionCompletedData,
  CollectionCreated,
} from "@copilotz/copilotz";
import type { NoteRecord, SaveNoteInput } from "./notes-plugin.ts";
```

Inside the existing `createCopilotz` options, **replace** the `namespace` value
with the imported `namespace`, **add** `database` from the same composition when
it is not already present, and **replace** the `plugins` value with
`[...runtimePlugins, ...agentPlugins]`. Keep `resources: agentResources` and any
other options unchanged. These properties now read:

```ts
// Notes and the agent harness use the same namespace and database choice.
namespace,
database,
// Each list keeps its existing plugins; the identical Notes dependency dedupes.
plugins: [...runtimePlugins, ...agentPlugins],
```

Inside `printReply`, in the `if (!isStreamOutput(output))` branch, **insert**
this block before that branch's final `continue`. Keep its existing model
failure check and any other Event diagnostics:

```ts
// Only durable facts prove that a Collection write or Action call was stored.
if (output.durable) {
  // The committed note, whichever caller saved it.
  if (output.type === "note.created") {
    const { record } = output.data as CollectionCreated<NoteRecord>;
    console.log(
      `event note.created note=${record.id} text=${
        JSON.stringify(record.text)
      }`,
    );
  }
  // The same Action outcome runtime callers and model tools receive.
  if (output.type === "notes.save.completed") {
    const { output: saved } = output.data as ActionCompletedData<
      SaveNoteInput,
      NoteRecord
    >;
    console.log(`event notes.save.completed note=${saved.id}`);
  }
  // The clock ran; its returned time reaches the model through the tool result.
  if (output.type === "copilotz.tools.builtin.get_current_time.completed") {
    console.log(`event ${output.type}`);
  }
}
```

The message, reply streaming, failure handling and cleanup stay unchanged. With
Chapter 5's `:memory:` composition, state lasts one process. Chapter 7's
persistent database choice keeps agent-made and runtime-made notes together, and
preserves the `team-notes-chat` thread across runs. Do not change that chosen
database while adding tools.

### What happens on a tool call

When the model decides to call `saveNote`, Core invokes the `saveNote` Action
alias in the same operation. The runtime validates the arguments against the
`notes.save` input schema, records `notes.save.invoked`, runs `execute`, which
stores the note and appends `note.created`, and records `notes.save.completed`.
Core passes the result back to the model, which then writes its reply. Invalid
arguments, such as empty text, fail validation the same way they do for
`app.ts`, and Core reports the tool error to the model instead of storing
anything.

## Check it works

Run `chat.ts` in the terminal where you exported `OPENAI_API_KEY`, with a prompt
that asks for both tools:

```sh
# Deno: -A grants environment, network and database access to the runtime.
deno run -A chat.ts "Save a note saying Prepare the release, then tell me the current time."
# Node 24+: runs chat.ts and its local .ts imports by stripping type annotations.
node chat.ts "Save a note saying Prepare the release, then tell me the current time."
```

The output looks something like this. The reply's wording, the time and every ID
differ on each run, and the reply may arrive before, between or after the Event
lines:

```text
accepted operation 01K2…
event note.created note=5b91… text="Prepare the release"
event notes.save.completed note=5b91…
event copilotz.tools.builtin.get_current_time.completed
I saved the note "Prepare the release". The current time is …
settled operation 01K2…: completed
```

Check these facts rather than the exact text:

- Exactly one `event note.created` line appears, and its text contains
  `Prepare the release`. The model chooses the exact wording, so it may drop or
  keep the full stop.
- An `event notes.save.completed` line appears with the same `note=` value.
- An `event copilotz.tools.builtin.get_current_time.completed` line appears.
  That Event proves the clock tool actually ran; the reply's wording, and
  whether it repeats the time, is up to the model.
- The last line is `settled operation <same ID>: completed`, and the command
  exits with status 0.

A model chooses whether to call a tool; the grant only makes the call possible.
If no `note.created` line appears, the model answered without the tool. Ask
again more explicitly, for example "Use the saveNote tool to save …". Then run
`chat.ts "Say hello!"`: no Notes Event lines should appear, because the
instructions tell the model not to save unasked.

The runtime path is unaffected. `app.ts "Prepare the release."` still runs
without Core or a credential, and the Chapter 6 tests still pass, because
neither imports `notes-tools.ts` or `agent.ts`.

Live model output is not something to assert in tests.
[Chapter 14](./14-test-agents-without-a-provider.md) replaces the provider with
a scripted model, so the same tool call can be checked automatically without a
credential.

## What this unlocks

The assistant now acts through the same validated operation as every other Notes
caller. You can:

- let a model use any existing Action by giving it a presentation and a grant,
  without copying its logic or weakening its validation;
- trace every agent-made change through the same lifecycle and Collection Events
  that runtime callers produce;
- decide per agent which tools it may use, while registration stays a separate
  host choice;
- add host-provided tools, such as the built-in clock, without writing a plugin;
- run the agent and the runtime entrypoints on one namespace, one database
  choice and one composed Notes package.

## Next steps

- Next: [Chapter 10: Connect APIs and MCP](./10-connect-apis-and-mcp.md) gives
  the assistant tools from an OpenAPI description and an MCP server.
- Optional, with Chapter 8 alone:
  [Chapter 11: Package Instructions as Skills](./11-package-skills.md).
- Reference: [Agent Capabilities](../../agent-capabilities.md) explains Tool
  resources, grants and how Core resolves them.
- Reference: [Actions](../../actions.md) covers Action definitions, validation,
  lifecycle Events and operation keys.
