# Events and processors

Copilotz uses one lower-case event vocabulary.

- Durable semantic facts include `message.created`, `llm_attempt.completed`, and
  `tool_execution.failed`.
- Ephemeral frames include `text.delta`, `reasoning.delta`, `audio.delta`, and
  `tool_call.delta`.

Durable events have a ULID and database-assigned monotonic position. Ephemeral
frames have neither; stream ordering uses `streamId` and `sequence` where
applicable.

```ts
const processor = defineProcessor({
  id: "memory.consolidation",
  on: ["message.created"],
  delivery: "durable",
  filter: (event) => event.namespace !== "demo",
  handle: async (event, context) => {
    await context.collections.memory.create({
      sourceEventId: event.id,
      text: event.payload,
    });
  },
});
```

Named subscriptions are independent. A durable event receives one delivery
obligation per matching processor ID. Durable filters must be synchronous and
pure because they run inside mutation planning; dynamic database/network
conditions belong in `handle`.

Execution is at-least-once. `context.idempotencyKey` is the stable delivery ID,
and collection mutations automatically derive operation keys from it. External
tools receive the same key and must implement their own idempotency contract.

`context.emit()` accepts ephemeral frames only. Durable state is created through
collections or typed domain operations. There are no post-write hooks,
emitted-event return values, swallowing, or raw graph escape hatches. Collection
`beforeCreate`, `beforeUpdate`, and `beforeDelete` hooks remain available for
validation and transformation.

Live processors use `delivery: "live"`. They observe process-lifetime events
without creating delivery rows and are not recoverable after a process exits.
