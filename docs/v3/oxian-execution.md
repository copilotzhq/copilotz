---
title: Copilotz v3 Oxian Execution
description: Durable delivery execution through private, shared, or remote Oxian workers.
section: Internal Design
status: implementation
---

# Copilotz v3 Oxian Execution

Copilotz executes guaranteed plugin work through the `copilotz.delivery.v1`
workload. The database remains authoritative for the event, logical consumer,
attempt count, lease, retry, and settlement. Oxian selects where the workload
runs and transports its byte streams; its worker or socket identity is not
persisted as domain state.

```text
immutable event + pending delivery
              │
              ▼
    Oxian dispatch (IDs only)
              │
              ▼
 worker atomically claims delivery lease
              │
              ▼
 resolve processor from plugin registry
              │
              ▼
 handle(event, context) → succeed/retry/dead-letter
```

## Factories

`createDeliveryExecutor()` coordinates dispatch and recovery.
`createDeliveryWorkload()` creates the workload installed in an embedded or
remote worker. Both return frozen plain records and functions.

```ts
const executor = createDeliveryExecutor({
  store,
  registry,
  createContext: ({ signal, idempotencyKey }) => ({
    collections,
    signal,
    idempotencyKey,
  }),
});

const handle = await executor.dispatchDelivery(delivery);
const result = await handle.done;
```

The default executor creates a private embedded Oxian `WorkerHost` and owns its
lifecycle. Passing `host` attaches one targeted Copilotz worker to an
application-owned shared host; shutdown removes only that worker. Passing
`dispatcher` sends work to an already hosted workload and never closes the
dispatcher, Hypervisor, connection, or remote worker.

External workers install the same handler:

```ts
const workload = createDeliveryWorkload({ store, registry, createContext });

workerHost.attachInProcessWorker({
  workerId: "copilotz-engine",
  workloads: { "copilotz.delivery.v1": workload },
});
```

The external host shown here is only illustrative. The handler has the same
Oxian workload contract when registered in an outbound WebSocket worker.

## Delivery boundary

Dispatch metadata contains only schema, event, delivery, logical consumer,
namespace, dispatch-attempt, and idempotency IDs. It contains no closures,
database objects, plugin code, or physical worker identity. The receiving worker
resolves the event and processor locally.

The workload claims the database delivery before invoking plugin code. This
makes a crash after event commit but before dispatch harmless: recovery finds
the pending row. A crash after Oxian acceptance but before claim also leaves the
row pending. Once claimed, a 120-second lease is renewed every 30 seconds;
failure or lease loss enters the store's retry/dead-letter policy. The stable
delivery ID is the mutation and external-effect idempotency key across every
attempt.

Every base processor context also exposes
`createMutationIdentity(operationKey)`. It propagates the source event's
causation and correlation and derives a child deduplication ID from the logical
delivery. Domain and collection writes can therefore survive a crash after their
own commit but before source-delivery settlement without duplicating the effect.

For the private host, Oxian's acceptance persistence callback is intentionally
process-local because the durable no-effect boundary is the subsequent database
claim. A Hypervisor may still persist its own operation acceptance
independently; neither mechanism replaces the delivery table.

## Current boundary

The execution seam is additive and now assembled by `createCopilotzEngine()`.
Its processor context is tenant-scoped and exposes typed domain/content/resource
capabilities, not the SQL session, event store, coordinator, or graph
primitives. A crash after typed LLM-attempt and collection projections is tested
through a real private-host delivery and retry. It does not yet replace the
legacy event worker. Built-in processors move next as complete event-native
verticals, after which the old queue dispatcher and processor coercion path can
be deleted rather than retained in parallel.

Realtime attachments will use a separate stream workload. They will share Oxian
lifecycle, cancellation, targeting, and Web Streams, while raw media frames
remain outside the durable event/delivery tables.
