---
title: Copilotz v3 Factory Engine Assembly
description: Factory-first composition of plugins, persistence, Oxian execution, content, and graph-native domains.
section: Internal Design
status: implementation
---

# Copilotz v3 Factory Engine Assembly

`createCopilotzEngine()` is the first executable composition root for the v3
core. It returns a frozen plain record and owns no application-provided database
session, shared Hypervisor, dispatcher, or remote Worker.

```text
app-owned SQL session + plugin registry
                  │
                  ▼
        createCopilotzEngine()
                  │
     ┌────────────┼──────────────┐
     ▼            ▼              ▼
 event store   Oxian executor   canonical assets
     │            │              │
     └──── event coordinator ─────┘
                  │
       graph-native repositories
  conversation / collections / LLM / tools
                  │
       tenant-scoped processor context
```

The engine can initialize the clean four-table schema, or accept an already
initialized schema. It constructs one event store and one set of repositories
over the injected session. A future public `createCopilotz()` adapter may own a
session; this core factory deliberately does not.

## Processor Boundary

Oxian delivery handlers receive `CopilotzProcessorContext`:

```ts
defineProcessor<CopilotzProcessorContext>({
  id: "agent.route",
  on: ["message.created"],
  delivery: "durable",
  async handle(event, context) {
    const message = await context.conversation.getMessage(event.subject!.id);
    const input = await context.content.prepare("...", {
      operationKey: "logical-input",
    });
    await context.llmAttempts.create({
      threadId: message!.threadId,
      messageId: message!.id,
      input,
    });
  },
});
```

The context contains:

- the durable event, logical delivery, cancellation signal, and stable
  idempotency helpers;
- namespace-bound canonical content preparation and resolution;
- namespace-bound participant/thread/message operations;
- namespace-bound custom plugin collections;
- namespace-bound LLM-attempt and tool-execution lifecycles; and
- read-only plugin resource lookup for agents, tools, providers, skills, and
  other resource types.

It intentionally excludes the SQL session, event store, coordinator, and raw
graph operations. Domain repositories no longer expose their coordinator.
Plugins therefore mutate through typed domain or collection operations, which
atomically create semantic events and delivery obligations.

Every scoped mutation derives causation, correlation, deduplication, and source
metadata from the current logical delivery. Content preparation derives a stable
body idempotency key from the same delivery plus an operation key. A processor
can crash after a child projection commits; retrying with newly prepared
transient asset IDs resolves to the original child domain record, event,
delivery set, and immutable body.

## Execution and Ownership

The engine delegates placement to `createDeliveryExecutor()`:

- no execution option creates and owns one private Hypervisor with in-process
  Workers;
- an injected Hypervisor gets Copilotz-owned Workers, which engine shutdown
  stops without closing the Hypervisor;
- an injected dispatcher is never shut down; and
- worker payloads remain IDs only.

`shutdown()` is idempotent and closes only executor infrastructure owned or
attached by this engine. The injected SQL session remains usable. `recover()`
dispatches available durable work, while `maintenance()` combines bounded
recovery with safe event/delivery compaction. No resident timer is required by
the core.

The engine can now execute `createTextWorkflowPlugin()` as an ordinary plugin.
This proves that agent, provider, and tool resources resolve inside the Oxian
worker while dispatch payloads remain delivery/resource IDs. Provider fallback
children, tool outputs, and participant messages are created only through the
typed context above.

## Public and Current Boundary

The factory is exported from the root package and `copilotz/engine`; the first
workflow plugin is exported from the root and `copilotz/workflows`. Every
surface is verified through an installed npm tarball. It is additive: the legacy
public `createCopilotz()` runtime still handles current production runs. The
remaining prompt/tool parity, memory, `ask`, and attachments must move as tested
verticals before that adapter switches to this engine and old queue code can be
deleted.
