# How Events Work

Events drive the asynchronous and staged execution model inside Copilotz.

## What Events Do

Events let Copilotz queue and process work such as:

- new messages
- llm calls
- tool calls
- tool results
- document ingestion

## Why Events Matter

You do not need to author event queues manually for common Copilotz workflows,
but understanding events helps you reason about asynchronous execution,
background work, and custom processors.

## Recommended Use Case

Use processors and built-in runtime flows when work belongs in the event
lifecycle.

## Common Mistaken Alternative

Do not force every piece of runtime work into synchronous route handlers when it
belongs in a staged or queued pipeline.

## Related Pages

- [Processors](../resources/processors.md)
- [How Threads Work](./how-threads-work.md)
- [How the Graph Works](./how-the-graph-works.md)
