---
title: Copilotz v3 Event-Native Collections
description: Plugin collection composition, atomic graph mutations, hooks, and delivery-scoped idempotency.
section: Internal Design
status: implementation
---

# Copilotz v3 Event-Native Collections

Plugin collection resources now have an additive event-native execution path.
The existing `defineCollection()` definitions remain the source of schema,
defaults, keys, relations, search projection, and type inference. A factory
binds each definition to graph storage, the event coordinator, and Oxian
delivery execution.

```ts
const records = createEventCollectionRepository({
  definition,
  coordinator,
  session,
  eventStore,
  validate,
});
```

`createEventCollections()` composes every effective `collections` resource from
the plugin registry. Plugin stable-ID precedence therefore also determines the
active collection definition.

## Mutation Contract

`create`, `update`, and `delete` each commit one transaction containing the
graph mutation, relation changes, immutable semantic event, and all matched
durable deliveries. Event types follow the collection vocabulary:

```text
<collection>.created
<collection>.updated
<collection>.deleted
```

The event subject carries the collection and record ID. Payloads contain the ID
and deltas contain field names or deletion state, not a duplicate record body.
Processors load the canonical collection record when needed.

`belongsTo` relations validate the parent under the same namespace and write a
deterministic parent-to-child edge in the mutation transaction. Missing parents,
validation failures, hook failures, and SQL failures roll back nodes, edges,
events, and deliveries together.

## Hooks and Validation

`beforeCreate`, `beforeUpdate`, and `beforeDelete` remain validation and
transformation capabilities. A validator is injected so runtime adapters can
compile the declared JSON Schema without coupling the core to one validator or
host runtime.

An event-native collection rejects `afterCreate`, `afterUpdate`, or
`afterDelete` at composition time. Their effects become independent named
processors subscribed to the corresponding semantic event. This removes the old
failure boundary where a write could commit and then an `after*` hook could make
the API call reject.

## Aggregate Commands

Named commands express domain mutations that depend on the latest aggregate
state without exposing transaction or locking primitives:

```ts
const counters = defineCollection({
  name: "counters",
  schema: counterSchema,
  commands: {
    increment: {
      execute({ current, input }) {
        const by = Number((input as { by?: number } | undefined)?.by ?? 1);
        return { value: Number(current.value ?? 0) + by };
      },
    },
  },
});
```

`collection.command(id, "increment", input, options)` locks the record, passes
an immutable snapshot and stable operation ID to the command, merges the
returned patch, runs `beforeUpdate` and schema validation, synchronizes content
and relations, and commits `<collection>.increment` with its delivery
obligations. The command is not executed again when a deduplication key is
replayed. The response resolves the current canonical aggregate, which may
include later successful commands.

The HTTP projection exposes the same mutation at
`POST /collections/:name/:id/commands/:command`; its `Idempotency-Key` header is
the command's operation identity. Commands are for atomic state transitions.
Independent reactions and external effects remain processors.

## Delivery-Scoped Collection Context

Workers receive namespace-scoped collection bindings:

```ts
const collections = eventCollections.withScope({
  namespace: event.namespace,
  createMutationIdentity: context.createMutationIdentity,
});

await collections.memory.create({
  id: memoryId,
  value,
});
```

The delivery context derives each child mutation's causation and correlation
from the source event and derives deduplication from the stable delivery ID plus
an operation key. If a processor commits the child collection mutation and then
crashes before settling its source delivery, retry returns the existing child
event and record. It does not duplicate the projection.

A create without an explicit record ID must provide `operationKey` in a delivery
scope. This prevents accidental retry-unsafe random identity.

## Current Boundary

The seam currently covers ID-based create/update/delete/command, tenant-scoped
get/list, defaults, timestamps, relations, compact events, before hooks, and
injected validation. Full query operators, population, index management,
semantic search, and reporting reads remain on the parity ledger.
