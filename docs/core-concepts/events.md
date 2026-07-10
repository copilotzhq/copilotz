---
title: Events
description: Events are the observable runtime surface for messages, LLM calls, tools, assets, and background work.
section: Core Concepts
order: 40
status: stable
---

# Events

Copilotz has two event surfaces:

- durable mutation events in the database outbox
- live stream projections returned by `copilotz.run(...)`

Durable events are produced by domain mutations. For example,
`ops.mutate.messages.create(...)` writes the message and appends a
`message.created` outbox row in the same transaction. The live stream still
emits uppercase events such as `TOKEN`, `TOOL_CALL`, `TOOL_RESULT`, and
`LLM_RESULT` so existing clients and adapters keep working.

## Durable Mutation Events

The physical table is still `events`, but durable workflow facts use lifecycle
names and subject fields:

| Event                      | Meaning                                |
| -------------------------- | -------------------------------------- |
| `thread.created`           | A thread graph node was created        |
| `message.created`          | A participant turn was persisted       |
| `message.updated`          | A message aggregate gained new parts   |
| `llm_attempt.created`      | A provider attempt started             |
| `llm_attempt.updated`      | Partial output, usage, or cost changed |
| `llm_attempt.completed`    | A provider attempt finished            |
| `llm_attempt.failed`       | A provider attempt failed or recovered |
| `tool_execution.created`   | A tool execution started               |
| `tool_execution.completed` | A tool execution returned output       |
| `tool_execution.failed`    | A tool execution errored               |
| `asset.created`            | An asset node was created              |

Outbox rows include `subjectType`, `subjectId`, `operation`, `causationId`,
`correlationId`, optional `dedupeKey`, structured `metadata`, and a compact
`payload` containing the mutation input. Snapshot columns such as `input`,
`before`, `after`, and `patch` still exist during the migration, but new runtime
mutations leave them empty to avoid duplicating large graph state.

## Live Stream Events

These are compatibility projections for UI and integration code:

| Event           | Meaning                                      |
| --------------- | -------------------------------------------- |
| `NEW_MESSAGE`   | A visible or history message was projected   |
| `TOKEN`         | A streamed model token was produced          |
| `LLM_CALL`      | The runtime is about to call an LLM provider |
| `LLM_RESULT`    | The LLM provider returned a result           |
| `TOOL_CALL`     | An agent requested a tool call               |
| `TOOL_RESULT`   | A tool call completed or failed              |
| `ASSET_CREATED` | An asset was extracted and stored            |
| `ASSET_ERROR`   | Asset extraction or storage failed           |
| `RAG_INGEST`    | A document ingestion job ran                 |
| `GOAL_STOPPED`  | A goal loop stopped                          |
| `GOAL_RESULT`   | A goal produced its final result             |

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
For LLM accounting and recovery debugging, inspect `llm_attempt` graph nodes.
They are canonical; `llm_usage` exists as a compatibility projection while admin
and older integrations migrate.

The same event stream supports both uses.

## Processors

Processors react to lifecycle facts and perform more domain mutations. Built-in
processors handle normal work like responding to messages, calling tools,
storing tool results, and running RAG ingestion.

Legacy custom processors that return `producedEvents` are still supported during
the migration. New core runtime code should prefer `ops.mutate.*` so state and
outbox facts are committed atomically.

For the legacy processor contract, the return value controls the remainder of
the processor chain:

| Return value                       | Behavior                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| `undefined` / `void`               | Pass to the next matching processor                         |
| `{ producedEvents: [event, ...] }` | Claim the event, enqueue new events, and skip the remainder |
| `{ producedEvents: [] }`           | Claim the event, enqueue nothing, and skip the remainder    |

Claiming an event changes its downstream handling; it does not replace or delete
the original queue row. The original row remains durable and is normally marked
`completed`, while each produced event is inserted as a new queue row. Likewise,
swallowing a lifecycle event does not roll back the domain mutation that created
that lifecycle fact—the mutation and outbox row may already have committed in
the same transaction.

Public stream events are emitted before their processor chain runs. A processor
can therefore prevent built-in processing and follow-up work, but it cannot
retract an original public event that has already been delivered to a run's live
event stream. Use transport/UI interception when an event must be hidden from a
client.

## Related Pages

- [Runs](../runtime/runs.md)
- [Tools, Features, and Processors](./tools-features-processors.md)
- [Run API](../reference/run-api.md)
