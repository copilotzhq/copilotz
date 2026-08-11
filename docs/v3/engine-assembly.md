---
title: Copilotz v3 Factory Engine Assembly
description: Factory-first composition of plugins, persistence, Oxian execution, content, and graph-native domains.
section: Internal Design
status: implementation
---

# Copilotz v3 Factory Engine Assembly

The module-private `createCopilotzEngine()` is the executable composition root
used by the public Embedded, Gateway, and Worker factories. It returns a frozen
plain record and owns no application-provided database, shared Hypervisor,
dispatcher, or remote Worker.

```text
app-owned Ominipg database + plugin registry
                       │
            private atomic SQL adapter
                       │
                       ▼
             createCopilotzEngine()
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
 one shared Oxian executor     lazy database scopes
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
           event store       canonical assets    graph repositories
                └──────── event coordinator ────────────┘
                                    │
                         schema-scoped capabilities
```

The application owns database lifecycle when it opens a database from
configuration. An injected database is always application-owned and remains
usable after Copilotz shuts down. The engine sees only a package-private atomic
SQL adapter.

The default physical schema is initialized eagerly. `databaseScope(name)` and
schema-bearing operations initialize additional physical schemas lazily. Each
scope owns its repositories, event store, attachment runtime, and event hub; all
scopes reuse the same Ominipg database, plugin registry, and Oxian executor.
Adding a tenant schema therefore does not create another database connection,
Worker, Hypervisor, scheduler, or resident timer.

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

It intentionally excludes the SQL adapter, event store, coordinator, and raw
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
  Workers on a unique event-fabric topic;
- an injected Hypervisor and explicit shared transport get Copilotz-owned
  Workers, which engine shutdown stops without closing the Hypervisor;
- an injected dispatcher is never shut down; and
- worker payloads remain IDs only.

`shutdown()` is idempotent and closes only executor infrastructure owned or
attached by this engine. Its application factory separately closes only a
database created from configuration. `recover()` dispatches available durable
work, while `maintenance()` combines bounded recovery with safe event/delivery
compaction. Both are scoped to one physical schema. No resident timer is
required by the core.

Delivery, live-event, and stream workloads carry `databaseSchema` as routing
metadata. Detached Workers resolve the matching lazy scope before loading an
event or delivery. Payloads still contain stable identities rather than
repository instances or closures.

The engine can now execute `createTextWorkflowPlugin()` as an ordinary plugin.
This proves that agent, provider, and tool resources resolve inside the Oxian
worker while dispatch payloads remain delivery/resource IDs. Provider fallback
children, tool outputs, and participant messages are created only through the
typed context above.

## Public Boundary

Applications choose `createCopilotz()`, `createCopilotzGateway()`, or
`createCopilotzWorker()`. The engine and raw workload map are deliberately not
package entry points. Plugin authors still receive the public
`CopilotzProcessorContext` type and typed capabilities assembled here.
