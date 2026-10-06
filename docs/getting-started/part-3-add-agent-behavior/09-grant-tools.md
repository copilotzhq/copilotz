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

`assistant.ts` stays a pure definition. This step makes two changes, shown in
the complete file below:

1. It **inserts** an `instructions` property after `role`, telling the model
   when to save.
2. It **replaces** the empty `tools` array inside `capabilities` with grants for
   `saveNote` and `get_current_time`. The `agents` and `skills` lists stay
   empty; nothing else changes.

```ts
// The Notes assistant: who it is, what it is for and which model it uses.
// Plain data, so tests and other compositions can import it without side
// effects. `as const` infers readonly, literal types for every value.
export const assistant = {
  // Stable Agent ID. Messages address the agent by this ID, and the stored
  // conversation records it as the agent's identity.
  id: "assistant",
  // Name recorded for the agent's participant in the conversation.
  name: "assistant",
  // The agent's purpose, which Core gives the model on every turn.
  role: "A notes assistant that helps the team capture and find notes.",
  // Guidance on when to use the granted tools. It steers the model; it does
  // not force a tool call.
  instructions:
    "When the user explicitly asks you to save or record a note, call the saveNote tool with the note text. When the user asks for the time or date, call the get_current_time tool. Do not save notes the user did not ask for.",
  models: {
    // Ordered model choices for generating replies; Core tries the first
    // choice first. `connection` names an entry that the host supplies in
    // `llmConnections`, so this file never holds a credential.
    generate: [{ connection: "openai", model: "gpt-5.4-mini" }],
  },
  // What the agent may use, granted by alias. `tools` now grants the Notes
  // tool and the built-in clock; Skills arrive in Chapter 11 and other agents
  // in Chapter 12.
  capabilities: {
    tools: ["saveNote", "get_current_time"],
    agents: [],
    skills: [],
  },
} as const;
```

The grants are aliases, the keys under `resources.tools`. They are not the
Action IDs (`notes.save`) and not the presentation names (`Save note`).

### Edit `agent.ts`

`agent.ts` stays the host composition module for the agent harness. This step
makes three changes, so the complete file follows:

1. It imports `notesToolsPlugin` from `./notes-tools.ts`, and the built-in clock
   tool, `getCurrentTimeToolResource`, from `@copilotz/copilotz/tools/builtin`.
2. It appends `notesToolsPlugin` to `agentPlugins`, after `corePlugin`.
3. It adds a `tools` map to `agentResources` with the clock under the alias
   `get_current_time`.

The credential check, the `openai` connection and the `agents` map are
unchanged.

The clock is added differently from `saveNote`. `getCurrentTimeToolResource`
carries its own Action. When the host places it under `resources.tools`,
composition installs that Action under the same alias and turns the entry into a
Tool, so no plugin is needed. Only this one built-in tool is added, and only the
assistant's grant lets the model use it.

```ts
// Core: conversations, agents, model calls and tools on the generic runtime.
// It brings the LLM plugin with it.
import { corePlugin } from "@copilotz/copilotz/core";
// Built-in clock tool. It carries its own Action, which composition installs.
import { getCurrentTimeToolResource } from "@copilotz/copilotz/tools/builtin";
// The host environment supplies the model credential.
import { env } from "node:process";
// The pure agent definition.
import { assistant } from "./assistant.ts";
// The Notes tool, packaged with its dependency on the Notes plugin.
import { notesToolsPlugin } from "./notes-tools.ts";

// Fail before anything is composed when the credential is missing. The message
// names the variable, never its value.
const apiKey = env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error(
    "Set OPENAI_API_KEY in the environment before running the agent.",
  );
}

// Plugins that the agent harness adds to an application: Core, then the Notes
// tool. Later chapters append to this list.
export const agentPlugins = [corePlugin, notesToolsPlugin];

// Resources that Core reads when it runs an agent turn. Later chapters add
// entries to these maps.
export const agentResources = {
  // Named model connections. Agents refer to them by name; only this host
  // module holds the credential.
  llmConnections: {
    // The connection that `assistant.models.generate` names.
    openai: {
      // Core's built-in OpenAI provider.
      provider: "openai",
      // Credential used only for calls made through this connection.
      auth: { apiKey },
    },
  },
  // Host-chosen tools, keyed by the alias that agents grant. Registering a
  // tool here makes it available; an agent still needs a grant to use it.
  tools: {
    // The built-in clock under the alias `assistant.ts` grants.
    get_current_time: getCurrentTimeToolResource,
  },
  // Agents that messages can address. The key is the composition alias;
  // messages address the agent by its `id`.
  agents: { assistant },
};
```

### Edit `chat.ts`

`chat.ts` stays an entrypoint. It now runs on the same host choices as `app.ts`,
so the note the agent saves lands in the application's Notes composition. This
step makes three changes, so the complete file follows:

1. It imports `namespace`, `database` and `runtimePlugins` from
   `composition.ts`, and the `NoteRecord` and `SaveNoteInput` types.
2. It passes `namespace` and `database` to `createCopilotz`, and composes
   `plugins: [...runtimePlugins, ...agentPlugins]`: the generic runtime plugins
   first, then the agent harness.
3. It prints the two Notes facts, `note.created` and `notes.save.completed`, and
   the clock's `copilotz.tools.builtin.get_current_time.completed` Event, while
   streaming the reply as before.

The message, the reply streaming and the failure handling are unchanged.

```ts
// Runtime factory, and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of the outputs this script reads and of the Notes Event data it prints.
import type {
  ActionCompletedData,
  ApplicationOutput,
  CollectionCreated,
  StreamOutput,
} from "@copilotz/copilotz";
// Core's helper that turns a chat message into an input Event.
import { message } from "@copilotz/copilotz/core";
// The prompt comes from the command line; reply text goes to standard output.
import { argv, stdout } from "node:process";
// Host composition: Core, the Notes tool, the model connection and the
// assistant.
import { agentPlugins, agentResources } from "./agent.ts";
// The application's own choices, shared with `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// Types of a stored note and of the Action's input, for reading results.
import type { NoteRecord, SaveNoteInput } from "./notes-plugin.ts";

// Writes one content stream to the terminal while its bytes arrive, then
// reports the stream's outcome when it did not complete.
async function printContent(output: StreamOutput): Promise<void> {
  // Decode UTF-8 incrementally, so characters split across chunks stay whole.
  const text = output.payload.pipeThrough(new TextDecoderStream());
  for await (const piece of text) stdout.write(piece);
  stdout.write("\n");
  // `terminal` reports how this stream ended. A failed model attempt can be
  // followed by a retry on a new stream, so `done` stays the authority on
  // whether the whole operation succeeded.
  const terminal = await output.terminal;
  if (terminal.outcome !== "completed") {
    console.log(`[reply stream ended: ${terminal.outcome}]`);
  }
}

// Reads all of the operation's outputs in order, prints the visible reply and
// the Notes facts, and returns whether a model call failed.
async function printReply(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<boolean> {
  let modelCallFailed = false;
  for await (const output of outputs) {
    if (!isStreamOutput(output)) {
      // Only recorded Events are inspected; live Events are skipped.
      if (!output.durable) continue;
      // The `note` Collection appends this Event when the tool's Action stores
      // a note. Its data holds the committed record.
      if (output.type === "note.created") {
        const { record } = output.data as CollectionCreated<NoteRecord>;
        console.log(
          `event note.created note=${record.id} text=${
            JSON.stringify(record.text)
          }`,
        );
      }
      // The `notes.save` Action appends this Event when the call succeeds,
      // whichever caller made it.
      if (output.type === "notes.save.completed") {
        const { output: saved } = output.data as ActionCompletedData<
          SaveNoteInput,
          NoteRecord
        >;
        console.log(`event notes.save.completed note=${saved.id}`);
      }
      // The recorded lifecycle Event of a model call that ended in failure,
      // after any retries and fallbacks inside that call. Only the flag is
      // kept; the Event's data, which may include provider details, is not
      // printed. Keep reading so the remaining outputs drain.
      if (output.type === "llm.call.failed") {
        modelCallFailed = true;
      }
      // The built-in clock's Action appends this Event when the model's clock
      // tool call succeeds. Only the type is printed; the time is in the reply.
      if (output.type === "copilotz.tools.builtin.get_current_time.completed") {
        console.log(`event ${output.type}`);
      }
      // Other recorded Events: not printed in this chapter.
      continue;
    }
    // The agent's visible reply text.
    if (output.role === "content" && output.mediaType.startsWith("text/")) {
      await printContent(output);
      continue;
    }
    // Reasoning, tool-call drafts and other streams: release this observer's
    // copy so it does not hold the operation's outputs open.
    await output.payload.cancel();
  }
  return modelCallFailed;
}

// The prompt to send, with a default so the script runs without arguments.
const prompt = argv[2] ?? "Say hello!";

// Compose the application's runtime plugins with the agent harness, on the
// application's own namespace and database.
const app = await createCopilotz({
  // Tenant namespace recorded on every conversation record, note and Event.
  namespace,
  // The shared database choice. Closing the application releases it.
  database,
  // Generic runtime plugins first, then Core and the Notes tool. The Notes
  // plugin appears in both lists as the same object and is registered once.
  plugins: [...runtimePlugins, ...agentPlugins],
  // The model connection, the clock tool and the assistant that Core reads.
  resources: agentResources,
});

try {
  // Admit one chat message. Core finds or creates the thread and the human
  // participant from their external IDs, records the message and runs the
  // addressed agent's turn, including any tool calls, within the same
  // operation.
  const handle = await app.send(message({
    // Application-owned thread name; the same name reuses the same thread.
    thread: { externalId: "team-notes-chat" },
    // Application-owned identity of the human who is speaking.
    participant: { externalId: "you", participantType: "human" },
    // Agent IDs that should receive the message and reply.
    recipientIds: ["assistant"],
    // The message text.
    content: prompt,
  }));
  console.log(`accepted operation ${handle.operationId}`);

  // Print the reply and Notes facts while waiting for settlement. `done`
  // resolves after the agent's turn and its tool calls finish, and Promise.all
  // rejects as soon as either side fails.
  const [modelCallFailed] = await Promise.all([
    printReply(handle.outputs),
    handle.done,
  ]);
  // A settled operation is not the same as a successful reply: Core records a
  // failed model call and still settles the turn. Report it as a failure.
  if (modelCallFailed) {
    throw new Error(
      `The model call failed in operation ${handle.operationId}. ` +
        "Inspect the recorded model-call failure for details.",
    );
  }

  // Read the operation's recorded state back by its ID.
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

`chat.ts` now uses whatever database `composition.ts` names. With Chapter 5's
`:memory:` choice, notes and the conversation last only for one process. If you
followed Chapter 7 and switched `composition.ts` to a file database, notes saved
by the agent persist alongside notes saved by `app.ts`, and the
`team-notes-chat` thread continues across runs.

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
