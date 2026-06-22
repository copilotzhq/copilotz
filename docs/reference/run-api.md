---
title: Run API
description: Message payload, run options, handle, and stream event shape.
section: Reference
order: 20
status: stable
---

# Run API

```ts
const handle = await copilotz.run(message, options);
```

## Message

Common message fields:

```ts
{
  content: string;
  sender: {
    id?: string;
    type: "user" | "agent" | "tool" | "system";
    name?: string;
  };
  target?: string;
  targetQueue?: string[];
  thread?: {
    id?: string;
    externalId?: string;
    participants?: string[];
    metadata?: Record<string, unknown>;
  };
}
```

## Options

```ts
{
  stream?: boolean;
  ackMode?: "immediate" | "onComplete";
  signal?: AbortSignal;
  queueTTL?: number;
  traceId?: string;
  eventMetadata?: Record<string, unknown> | null;
  namespace?: string;
  schema?: string;
  agents?: Agent[];
  tools?: Tool[];
}
```

## Handle

```ts
{
  queueId: string;
  threadId: string;
  status: "queued";
  events: AsyncIterable<StreamEvent>;
  done: Promise<void>;
  cancel: () => void;
}
```

## Stream Events

`events` yields live uppercase projections for UI and integration code. Durable
workflow facts are written as mutation outbox rows such as `message.created`,
`llm_attempt.completed`, and `tool_execution.failed`.

Important stream conventions:

- `TOKEN` events are non-durable streaming hints.
- `LLM_RESULT` metadata may include `llmAttemptId` and compatibility
  `usageNodeId`.
- `<no_response/>` produces a terminal empty `LLM_RESULT` and no default
  visible assistant bubble.
- `TOOL_CALL` and `TOOL_RESULT` metadata may include `toolExecutionId`; use that
  id for durable tool output lookup when available.

## Related Pages

- [Runs](../runtime/runs.md)
- [Events](../core-concepts/events.md)
