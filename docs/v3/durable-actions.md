---
title: Copilotz v3 Durable Actions
description: Persisted action lifecycle events for Features, LLM calls, tools, and other executable work.
section: Internal Design
status: implementation
---

# Copilotz v3 Durable Actions

Copilotz separates durable meaning from durable execution.

- **Collections** own semantic graph state and emit persisted mutation events.
- **Actions** are Feature executions and emit persisted lifecycle events.
- **Processors** receive committed events and may call Features or mutate
  Collections.

Action is not a fourth plugin declaration kind and has no separate invocation
API. Calling `context.feature(definition).action(input)` executes that Feature
action immediately through the runtime-owned lifecycle below.

## Canonical lifecycle

For Feature `F` and action `A`, runtime derives exactly this event family:

```text
<F.id>.<A>.invoked
<F.id>.<A>.completed
<F.id>.<A>.failed
<F.id>.<A>.cancelled
```

There is no separate `started` state. Placement, delivery leases, and worker
attempts are runtime infrastructure rather than public Action vocabulary.

The lifecycle is independent of `inputSchema` and `outputSchema`. Those schemas
only provide optional validation and type inference. Runtime persists input and
output for every action call whether schemas exist or not.

## Self-contained Event Bodies

Every Action event uses the existing EventBodyStore. The body is JSON-safe and
self-contained for the lifecycle transition:

```ts
type ActionEventData<I = unknown, O = unknown> =
  | Readonly<{
    actionRunId: string;
    actionId: string;
    parentActionRunId?: string;
    status: "invoked";
    input: I;
  }>
  | Readonly<{
    actionRunId: string;
    actionId: string;
    parentActionRunId?: string;
    status: "completed";
    input: I;
    output: O;
  }>
  | Readonly<{
    actionRunId: string;
    actionId: string;
    parentActionRunId?: string;
    status: "failed" | "cancelled";
    input: I;
    error: SerializedError;
  }>;
```

Terminal bodies repeat the invocation input deliberately. A Processor receives
the resolved body as `event.data`, just as it receives a resolved Collection
Event Body; it does not query or join an earlier lifecycle event.

Action input and output may be any Event-Body-safe value. They need not be a
Collection record. Large or binary values cross the boundary as durable
Content/Asset references rather than process-local streams, clients, closures,
sessions, or handles. An absent JavaScript input or output is normalized to
`null` in the durable body.

Event subjects are `{ type: actionId, id: actionRunId }`. The ordinary envelope
owns namespace, correlation, causation, visibility, routing, deduplication,
settlement, and timestamps. `parentActionRunId` is generic nested-execution
identity; thread, message, participant, agent, usage, cost, provider, and tool
fields remain plugin-owned input/output data.

## Invocation and reaction

`invoked` is a durable fact emitted immediately before execution. It is not a
queue command that asks another Processor to execute the same action:

```text
Processor receives prior event
  -> calls Feature action
     -> runtime commits <action>.invoked { input }
     -> Feature executes immediately
     -> runtime commits one terminal event { input, output | error }
```

Processors may subscribe to any lifecycle event. Terminal Processors can make
their next decision from `event.data` without reading an Action projection or an
operational Collection.

## Operational Collections disappear

`llm_attempt` and `tool_execution` duplicate operational facts represented by
Action events and are deleted in Phase 10D7:

```text
LLM generation/session       -> LLM Feature lifecycle
tool execution               -> Tool Feature lifecycle
```

Provider retries and fallbacks performed inside one LLM Feature action are
attempt-accounting entries in that Action's terminal output, not synthetic child
Actions. A provider call receives its own lifecycle only when a plugin actually
declares and invokes it as a Feature action.

Messages remain a semantic Collection because they are the durable transcript
used to reconstruct threads and conversations. A Processor interested in one
particular Feature result may consume its `.completed` event. A Processor that
must react whenever a semantic record changes consumes the Collection event,
regardless of which Feature or caller performed the mutation.

Final assistant messages, tool-visible messages, Assets, usage records, and
other durable business meaning remain in their owning Collections. Their
production may be driven by self-contained Action terminal events.

## Query boundary

Normal Feature and Processor contexts expose neither `context.actions` nor a
generic event-history reader. A Processor already receives its triggering event
and resolved `event.data`. Recurring semantic reads use Collection queries;
plugin-owned projections may be built by Processors when a real domain requires
them.

The EventStore remains runtime infrastructure for persistence, delivery,
deduplication, replay, and private retry recovery. It may recognize a previously
committed terminal event by stable action identity without exposing an
`ActionRun` API or requiring a public projection table.

## Observability

`copilotz.observe()` carries committed Collection events, committed Action
lifecycle events, and runtime-native stream output. Raw token/audio/media frames
remain ephemeral; the final durable Action output contains only Event-Body-safe
data and durable content references.
