---
name: add-processor
description: Create an independent named subscription to Copilotz semantic events.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, events, processor, plugin]
---

# Add Processor

Processors are logical plugin resources. Each processor ID is an independent
subscription; durable processors receive at-least-once deliveries through Oxian.

```ts
import {
  definePlugin,
  defineProcessor,
} from "jsr:@copilotz/copilotz@3/plugins";
import type { CopilotzProcessorContext } from "jsr:@copilotz/copilotz@3/engine";

const processor = defineProcessor<CopilotzProcessorContext>({
  id: "acme.audit-message",
  on: ["message.created"],
  delivery: "durable",

  // Durable filters run while matching the atomic mutation. Keep them pure,
  // synchronous, deterministic, and free of I/O.
  filter: (event) => event.visibility !== "restricted",

  async handle(event, context) {
    if (!event.durable || !event.subject) return;

    await context.collections.audit.create({
      id: `audit:${event.id}`,
      messageId: event.subject.id,
      eventPosition: event.position,
    }, { operationKey: "record-message" });
  },
});

export default definePlugin({
  manifest: {
    id: "@acme/audit",
    version: "1.0.0",
    provides: { processors: [processor.id] },
  },
  resources: { processors: [processor] },
});
```

## Semantics

- Use `delivery: "durable"` for guaranteed work and `"live"` for ephemeral
  observations such as `text.delta` or `audio.delta`.
- Different processor IDs run independently. Reusing the same ID in a later
  plugin or top-level resource intentionally overrides the earlier resource.
- Put dynamic checks, network calls, and reads inside `handle()`.
- Durable execution is at-least-once. Use scoped capabilities and stable
  `operationKey` values so built-in mutations deduplicate retries.
- External side effects receive `context.idempotencyKey`; propagate it to the
  remote system whenever possible.
- Throw to retry/fail the delivery. Returning normally succeeds only this
  processor's delivery.

Processor context exposes scoped conversation, collections, relations, content,
events, LLM attempts, tool executions, schedules, knowledge, and resources. It
does not expose raw graph writes or SQL. Post-write behavior belongs here;
collection hooks are only for `beforeCreate`, `beforeUpdate`, and `beforeDelete`
validation/transformation.
