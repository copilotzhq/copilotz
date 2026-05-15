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

## Related Pages

- [Runs](../runtime/runs.md)
- [Events](../core-concepts/events.md)
