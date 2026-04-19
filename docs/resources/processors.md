# Processors

Processors handle event-driven runtime work.

## Where It Lives

```txt
resources/processors/<processor-name>/
```

## What It Is For

Use a processor when work should happen as part of the event lifecycle instead
of as a direct synchronous app call.

Recommended use case: queued or background runtime behavior  
Most common mistaken alternative: putting asynchronous orchestration only in
custom route logic

## How Copilotz Consumes It

- processors are registered with the event engine
- events are dispatched to the matching processor during runtime execution
- built-in processors handle message ingress, tool execution, llm calls, and
  other run lifecycle work

## Minimal Example

```ts
export default {
  eventType: "MY_EVENT",
  execute: async (event, deps) => {
    return { ok: true };
  },
};
```

## Public Surface

Processors are runtime-facing. They do not become public HTTP endpoints on their
own.

## Related Pages

- [How Events Work](../runtime/how-events-work.md)
- [Tools](./tools.md)
- [createCopilotz](../reference/create-copilotz.md)
