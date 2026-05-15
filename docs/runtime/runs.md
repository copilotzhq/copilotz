---
title: Runs
description: copilotz.run is the core primitive for processing one inbound message.
section: Runtime
order: 10
status: stable
---

# Runs

`copilotz.run(...)` is the core runtime primitive.

It takes one inbound message, queues the work, streams events, and resolves when
processing completes.

## Shape

```ts
const run = await copilotz.run(message, options);

for await (const event of run.events) {
  // live runtime events
}

await run.done;
```

## What a Run Does

A run can:

- persist the inbound message
- load thread history
- route to an agent
- call an LLM
- stream tokens
- execute tools
- persist tool results
- create assets
- enqueue background work
- emit events for observers

## Run Handle

A run handle contains:

- `queueId`
- `threadId`
- `status`
- `events`
- `done`
- `cancel`

## Options

Run options can override:

- streaming
- acknowledgement mode
- cancellation signal
- queue TTL
- namespace
- schema
- agents for this run
- tools for this run

## Related Pages

- [Run API](../reference/run-api.md)
- [Events](../core-concepts/events.md)
- [Thread Routing](./thread-routing.md)
