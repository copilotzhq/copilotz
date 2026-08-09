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

The default executor creates a unique in-process event-fabric transport, a
private Oxian Hypervisor, and targeted Workers, and owns their lifecycle.
Passing `hypervisor` and its explicit `transport` binds those Copilotz-owned
Workers to an application-owned Hypervisor; shutdown stops only those Workers.
Passing `dispatcher` sends work to an already hosted workload and never closes
the dispatcher, Hypervisor, connection, or remote Worker.

External workers install the same handler:

```ts
const workload = createDeliveryWorkload({ store, registry, createContext });

const transport = {
  type: "in-process",
  config: { topic: "acme.copilotz" },
} as const;

const hypervisor = createHypervisor({ transports: [transport] });

const worker = createWorker({
  id: "copilotz-engine",
  transport,
  workloads: { "copilotz.delivery.v1": workload },
});
await worker.ready;
```

The handler has the same Oxian workload contract when the Worker's transport is
changed to an outbound WebSocket descriptor.

At the application assembly level, `application.execution.workloads` exposes the
complete worker-local map created by that application (delivery, live, and
stream workloads). An outbound worker can register this map directly. This is a
closure export within the worker process, not a dispatch payload; gateway and
worker still exchange identities and streams only.

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

The private Hypervisor intentionally has no transport-level durable acceptance
callback because the delivery workload claims the database row before plugin
effects. A shared or remote embedding may still persist Oxian's acceptance
through its `onWorkAccepted` Hypervisor lifecycle callback. That transport
boundary and Copilotz's delivery table are complementary; neither replaces the
other.

## Runtime boundary

`createCopilotzEngine()` assembles durable delivery, live processor, and
realtime stream workloads over this one Oxian lifecycle. Processor context is
tenant-scoped and exposes typed domain/content/resource capabilities, not the
SQL session, event store, coordinator, or graph primitives. Realtime attachment
frames use the stream workload and remain outside durable event/delivery tables;
their semantic open/close/transcript/message events use the ordinary event
model.
