---
title: Events
description: Events are the observable runtime surface for messages, LLM calls, tools, assets, and background work.
section: Core Concepts
order: 40
status: stable
---

# Events

Copilotz is event-driven.

`copilotz.run(...)` creates work and returns a live event stream. The runtime
then emits events as messages are persisted, models are called, tools run,
assets are created, and background processors continue the work.

## Common Events

| Event           | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `NEW_MESSAGE`   | A user, agent, tool, or system message was added |
| `TOKEN`         | A streamed model token was produced              |
| `LLM_CALL`      | The runtime is about to call an LLM provider     |
| `LLM_RESULT`    | The LLM provider returned a result               |
| `TOOL_CALL`     | An agent requested a tool call                   |
| `TOOL_RESULT`   | A tool call completed or failed                  |
| `ASSET_CREATED` | An asset was extracted and stored                |
| `ASSET_ERROR`   | Asset extraction or storage failed               |
| `RAG_INGEST`    | A document ingestion job was queued or processed |
| `GOAL_STOPPED`  | A goal loop stopped                              |
| `GOAL_RESULT`   | A goal produced its final result                 |

## Listen to a Run

```ts
const run = await copilotz.run(message);

for await (const event of run.events) {
  console.log(event.type, event.payload);
}

await run.done;
```

## Display vs Debug

For a clean chat UI, display user-facing agent messages.

For debugging, also log tool calls, tool results, LLM calls, and asset events.

The same event stream supports both uses.

## Processors

Processors react to events. Built-in processors handle normal work like
responding to new messages, calling tools, storing tool results, and running RAG
ingestion.

Custom processors are how you extend the runtime pipeline.

## Related Pages

- [Runs](../runtime/runs.md)
- [Tools, Features, and Processors](./tools-features-processors.md)
- [Run API](../reference/run-api.md)
