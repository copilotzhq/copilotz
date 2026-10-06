---
title: "Chapter 13: Remember Across Conversations"
description: "Add the Memory plugin so the assistant keeps curated, provenance-aware memory beside the original conversation history, with bounded consolidation and retrieval."
section: Getting Started
order: 130
status: stable
---

# Chapter 13: Remember Across Conversations

> Part 3 — Add Agent Behavior · Track: H (optional) · Requires: Chapter 8 ·
> Recommended: Chapter 7 for persistence · Needs: Deno 2.9+ or Node 24+, and an
> `OPENAI_API_KEY` for live consolidation

## The pain

The assistant from Chapter 8 replays its thread's history on every turn. That
works for a short chat. As the thread grows, each turn sends more old messages
to the model, and the facts that matter, such as "our stand-ups are on Monday"
or "keep notes under three lines", end up buried among small talk.

Trimming old messages by hand saves tokens but loses those facts. Summarizing
them by hand loses something else: nobody can tell which message a summary came
from, who was allowed to see it, or whether it replaced the original.

## The problem

Long-running conversations need two separate layers:

1. **History** is the original record of messages, with their senders and
   visibility. Consolidation reads it but never rewrites or deletes it.
2. **Memory** is a curated set of selected facts, built from a bounded range of
   that history. Each fact keeps track of where it came from, and its scope
   follows who could see the source.

The second layer has to be bounded too. Consolidation is itself a model turn, so
it needs a clear rule for when it starts, how much history it reads, and how
much memory comes back into later prompts.

Memory isn't the only layer that sits beside history. **Knowledge** holds
indexed sources and their embeddings for search, and **Spaces** hold owned
content with their own attachment rules. Both have complete examples in their
references; this chapter covers Memory only.

## The solution

The **Memory plugin** adds that curated layer on top of Core. When the plugin is
composed, it:

- records **checkpoints** in its `long_term_memory` Collection, each covering a
  bounded range of one agent's history in one thread;
- adds the `search_memory` and `consolidate_memory` tools, along with a few
  inspection tools, to the composed resources;
- adds the agent's ready memory to later prompts as context, and lets Core leave
  out raw history that a certified checkpoint already covers.

### When consolidation starts

The check doesn't count messages. On an ordinary agent turn, Core prepares the
history it's about to send to the model and hands that already-prepared history
to the Memory plugin. The plugin adds up the estimated tokens of that history.
When the total reaches `triggerEstimatedTokens`, it reserves a **pending**
checkpoint. The turn itself continues as usual.

The checkpoint's source is bounded twice:

- Core works out how much history fits in the agent's model after the normal
  prompt prefix, the tool schemas and an output allowance (1000 estimated tokens
  when the model doesn't configure one).
- The plugin subtracts the size of its own maintenance instruction and source
  manifest from that, and selects source messages within what remains.

Then the plugin keeps the most recent `retainRecentEstimatedTokens` of history
raw. One checkpoint doesn't always cover every older message: if the eligible
history is larger than one bounded source range, the rest stays as raw tail for
a later checkpoint.

These are estimates, not exact provider tokens or characters, and the trigger
isn't a hard context limit. A low trigger doesn't guarantee that the provider's
whole prompt fits, and a high one doesn't stop Core from compacting when a model
call is about to be too large.

### How the scoped task runs

Creating a pending checkpoint records a `long_term_memory.created` Event. The
plugin reacts to it by sending the agent an internal, scoped task message. The
task carries a small checkpoint reference and a maintenance instruction, not a
copy of the history. The agent's normal history preparation supplies the source
messages, so the scoped turn shares its preparation and its common prompt prefix
with ordinary turns. That prefix can be cached by the provider, but no cache hit
is guaranteed.

The agent finishes the task by calling `consolidate_memory` with the facts it
selected. That alias runs the `copilotz.memory.consolidation.commit` Action,
which validates the proposal: its shape, the permitted memory kinds, each fact's
provenance and scope, and that the source range is still certified. It can't
prove that the model's claims are true. Valid facts are stored and the
checkpoint becomes **ready**. If the model call fails or is cancelled, the
checkpoint becomes **failed** or **cancelled** instead. If source messages were
edited or deleted after the checkpoint was reserved (Core's HTTP API supports
both), certification fails and that maintenance doesn't apply. In every case the
source messages are left as they are.

### Consolidation runs in the background

The plugin's dispatch Processor is **detached**: a normal turn's `handle.done`
settles without waiting for consolidation. `chat.ts` closes the application
right after `done`, so a one-shot run can end before the scoped task starts or
finishes, and `app.close()` doesn't wait for detached work. With a persistent
database, the pending work stays recorded for a running or restarted application
to pick up, but running `chat.ts` many times isn't a reliable way to finish it.
Completed consolidation needs a long-lived application or Worker that stays
active. [Chapter 19](../part-5-operate-and-scale/19-schedule-recurring-work.md)
and [Chapter 21](../part-5-operate-and-scale/21-deploy-and-scale.md) cover
keeping one running.

A turn whose model call would be too large is the exception: Core's foreground
compaction can wait for a scoped checkpoint before that turn continues.

`consolidate_memory` is only accepted inside that trusted scoped task. Calling
it from a plain `app.send` or from your own Processor doesn't produce memory,
because the call lacks Core's task and tool provenance. And because the scoped
task is a model turn, consolidation uses your provider connection and can incur
model work. This chapter makes no claim about cost.

### Scope

By default, each checkpoint covers one agent's history in one thread, and its
memories are stored in that thread's memory space. Two things read them
differently:

- **Prompt context:** later turns of the same agent in the same thread use that
  agent's certified ready checkpoint. Other agents in the thread don't receive
  it as their own memory.
- **Search:** `search_memory` looks through memory records in every space the
  caller can access, including spaces shared with explicit access permissions.
  So a stored memory isn't necessarily private to one agent.

Nothing is retrieved across every thread or across namespaces automatically. The
[Memory reference](../../memory.md) covers memory spaces, sharing and access
rules.

### Add the plugin and its configuration in `agent.ts`

`agent.ts` stays the host composition module. Make three small edits and leave
everything else, including any connections, tools, integrations and agents from
Chapters 9 to 12, as it is. A complete file isn't shown because your copy may
include optional chapters that a full replacement would erase.

**Insert** this import after the existing `corePlugin` import:

```ts
// Curated long-term memory over Core conversations.
import { memoryPlugin } from "@copilotz/copilotz/memory";
```

**Append** `memoryPlugin` to the end of the existing `agentPlugins` list,
keeping every plugin already there. With only Chapter 8 the result is
`[corePlugin, memoryPlugin]`; after Chapter 9 it's:

```ts
// Plugins that the agent harness adds to an application: Core, the Notes tool
// and Memory. Later chapters append to this list.
export const agentPlugins = [corePlugin, notesToolsPlugin, memoryPlugin];
```

**Insert** this property into the `agentResources` object, after
`llmConnections`:

```ts
// Memory policy for every agent in this application.
memory: {
  config: {
    // Memory is on by default; set false to turn it off without removing
    // the plugin.
    enabled: true,
    // Start a checkpoint once the prepared ordinary history reaches about
    // this many estimated tokens. This is the library default.
    triggerEstimatedTokens: 20000,
    // Keep about this much recent history raw, outside the checkpoint. The
    // library default is 0; this application chooses to keep the latest
    // exchange verbatim.
    retainRecentEstimatedTokens: 2000,
    // Upper bound for the memory text rendered back into a prompt. This is
    // the library default.
    maxContentEstimatedTokens: 12000,
    // Maximum number of memories `search_memory` returns. This is the
    // library default.
    retrievalLimit: 20,
  },
},
```

`retainRecentEstimatedTokens: 2000` is this application's policy. Leave it out
and the library uses `0`. The other three values match the defaults; writing
them down keeps the policy visible in one place.

### Grant the tools in `assistant.ts`

`assistant.ts` stays a pure definition module. **Append** the two Memory aliases
to the end of the existing `tools` list inside `assistant.capabilities`, keeping
every tool already granted. Leave the `agents` and `skills` lists unchanged.
With only Chapter 8 the result is `["search_memory", "consolidate_memory"]`;
after Chapter 9 it's:

```ts
// Tools the assistant may call: Notes, the clock, and Memory.
tools: ["saveNote", "get_current_time", "search_memory", "consolidate_memory"],
```

Both grants are required. `search_memory` lets the assistant look things up in
its memory. `consolidate_memory` is how the scoped task finishes; without it the
task can't complete and no checkpoint becomes ready.

The aliases exist only because `memoryPlugin` is composed. If `assistant.ts`
grants them while `agent.ts` doesn't include the plugin, composition fails
because the granted tools don't exist.

`chat.ts` doesn't change. It already composes `agentPlugins` and
`agentResources`.

### Persistent host composition (requires Chapter 7)

The Chapter 8 `chat.ts` gives no `database`, so every process starts with an
empty private in-memory database. Memory then lasts only as long as one
application: a new `chat.ts` process has neither the history nor its
checkpoints, even though it uses the same thread external ID. Reusing an ID
doesn't make anything persist.

If you followed Chapter 9, `chat.ts` already passes `namespace` and `database`
from `composition.ts`, so it uses whatever database Chapter 7 chose. Skip this
step.

Otherwise, this optional step needs `composition.ts` from Chapter 5, switched to
a file database in Chapter 7. Make two edits to `chat.ts`, and keep its plugins
and resources as they are.

**Insert** this import after the `./agent.ts` import:

```ts
// The application's namespace and database choice. Only these host choices
// are used here; the plugins and resources still come from agent.ts.
import { database, namespace } from "./composition.ts";
```

**Replace** the `createCopilotz` call with this one:

```ts
// Compose the agent harness on the application's namespace and database, so
// history and memory checkpoints outlive this process.
const app = await createCopilotz({
  // Tenant namespace recorded on every conversation record and Event.
  namespace,
  // The database that composition.ts chose. Closing the application
  // releases it.
  database,
  // Core and Memory, plus anything earlier chapters added.
  plugins: agentPlugins,
  // The model connection, Memory policy and the assistant.
  resources: agentResources,
});
```

## Check it works

From the project directory, in the terminal where you exported `OPENAI_API_KEY`,
state a durable preference and then keep talking:

```sh
# Deno
deno run -A chat.ts "From now on, keep every note under three lines."
deno run -A chat.ts "Suggest notes worth taking after today's stand-up."
# Node 24+
node chat.ts "From now on, keep every note under three lines."
node chat.ts "Suggest notes worth taking after today's stand-up."
```

Check these facts first:

- Both commands compose without an error about unknown tools, reply as before,
  and exit with status 0. That confirms the plugin, the configuration and both
  grants line up.
- In a fresh thread, two short messages stay far below 20,000 estimated tokens,
  so **no consolidation starts**. These commands check composition only. In a
  thread that already has a long history near the trigger, even a short new
  message can cross it.
- Saying "remember this" doesn't create memory right away. Memory comes from
  consolidating eligible history, not from one prompt.

Completed consolidation needs two things: a thread whose prepared ordinary
history has crossed the trigger, and an application that stays running, or is
restarted on the same persistent database, long enough to run the detached
scoped task. One-shot `chat.ts` runs don't provide the second. In such an
application, look for these facts in its recorded Events and Collections rather
than in the reply text:

- a `long_term_memory.created` Event for a checkpoint with status `pending`;
- a `copilotz.memory.consolidation.commit.completed` Event, recorded when the
  scoped model turn called `consolidate_memory`;
- a `long_term_memory.updated` Event whose `data.record.status` is `ready`, or a
  status of `failed` or `cancelled` with an error if the scoped model call
  didn't succeed;
- on later turns in the same thread, ready memory in the assistant's context,
  with the source messages still in history.

These facts have no fixed order. The `ready` update can appear before the commit
Action's `completed` Event, so no single Event on its own shows that the whole
scoped task has finished.

## What this unlocks

- Long threads whose prompts carry curated memory instead of an ever-growing
  replay, while consolidation leaves the source messages as they are.
- Memory you can trace: facts are validated against a certified source range and
  stored in memory spaces with explicit access.
- One visible policy for when consolidation starts, how much it reads and how
  much memory returns to prompts.
- A clear split between History, Memory, Knowledge and Spaces, so each piece of
  data lives in the layer that fits it.

## Next steps

- Next:
  [Chapter 14: Test Agents Without a Provider](./14-test-agents-without-a-provider.md)
  replaces the model with a scripted adapter. It requires Chapters 6 and 9.
- Runtime track (optional):
  [Chapter 15: Expose an HTTP API](../part-4-release-to-users/15-expose-an-http-api.md)
  serves the Notes runtime over HTTP.
- Reference: [Memory](../../memory.md) for checkpoints, memory spaces, budgets
  and the full tool set.
- Reference: [Knowledge](../../knowledge.md) and [Spaces](../../spaces.md) for
  complete examples of indexed sources and owned content.
