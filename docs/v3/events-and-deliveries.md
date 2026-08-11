---
title: Copilotz v3 Events and Durable Deliveries
description: Immutable semantic facts, sparse guaranteed-work obligations, causal settlement, and the explicit v1 database upgrade.
section: Internal Design
status: implementation
---

# Copilotz v3 Events and Durable Deliveries

## Current Status

The event and delivery engine in `runtime/events/` is the canonical persistence
path used by `createCopilotz()`. It is composed of factories, functions, plain
records, and a narrow injected SQL session. Domain mutations commit semantic
events and sparse delivery obligations atomically; post-commit execution uses
the Oxian workloads assembled behind the role factories. There is no legacy
event worker or dual dispatch path.

## Storage Model

A clean v3 schema contains four tables:

```text
nodes ───── graph domain records and custom collections
edges ───── graph relationships
events ──── immutable, positioned semantic facts
event_deliveries ── mutable guaranteed-work obligations
```

An event contains identity, schema version, type, namespace, optional thread and
subject, payload/delta references, routing, visibility, causation, correlation,
deduplication, and creation time. It has no processing status or update time. A
database trigger rejects direct event updates; retention may delete an event
only after its durable work is safely settled.

Delivery records use stable logical consumer IDs. Physical Oxian worker IDs are
never persisted. The unique `(event_id, consumer_id)` constraint means duplicate
consumer matching cannot multiply work. Passive observers and events with no
actionable consumer create no delivery rows.

## Atomic Mutation Protocol

`createEventStore()` receives an injected transaction-capable SQL session. Its
`commitMutation()` operation performs the domain/graph mutation, event insert,
delivery inserts, and thread activity update in one transaction. Any failure
rolls back every part.

Deduplication is namespace-scoped. Replaying the same semantic draft returns the
existing event and deliveries without rerunning the mutation. Reusing a
deduplication ID for different payload, routing, visibility, subject, or
causation data fails explicitly.

Consumers are resolved before this call by the plugin registry. The store
accepts IDs, never filters, processor closures, or worker placement.

The implemented [Oxian execution seam](./oxian-execution.md) consumes these
logical delivery rows through `copilotz.delivery.v1`. The worker claims the row
before plugin effects and resolves the processor from its local registry.

## Delivery Lifecycle

The implemented states are:

```text
pending → leased → succeeded
              └→ retry_wait → leased
              └→ dead_letter → pending (manual retry)
                              └→ cancelled (discard)
```

Defaults are a 120-second lease, three attempts, exponential full-jitter retry,
and a 30-second retry cap. Heartbeats require the current owner and an unexpired
lease. Atomic claims prevent concurrent owners. An expired final lease becomes a
dead letter, so repeatedly crashing work cannot remain leased forever.

Recovery queries return only available pending/retry work or expired leases.
This covers a process crash after commit and before dispatch. Idempotent output
events use semantic deduplication, so a crash after output commit but before
source settlement cannot duplicate the output.

## Causal Settlement

Settlement follows the transitive `causation_id` tree rooted at the accepted
input event. It does not wait for unrelated work that happens to share a
correlation ID. The scope reports unsettled, succeeded, cancelled, and
dead-lettered deliveries independently. Cancellation changes only unsettled
deliveries in that causal tree.

This is the persistence primitive that will back `RunHandle.done` and attachment
send handles when the runtime is ported.

## Retention

Compaction defaults to seven days and can be disabled with indefinite retention.
It removes only succeeded/cancelled delivery rows and events with no retained
delivery or causal child. Pending, leased, retrying, and dead-lettered work is
never compacted. Causal parents may remain for an additional maintenance pass,
which favors recoverability over eager deletion.

## Explicit v1 Upgrade

The one-way upgrader is available only from `copilotz/migration/v1`. The normal
runtime never imports it.

For every selected tenant schema it:

1. refuses to run while queue rows are pending/processing or a thread lease is
   active;
2. stages the legacy four tables inside one transaction;
3. creates the clean v3 baseline;
4. preserves graph node and edge IDs and arbitrary custom node data;
5. merges physical thread fields into thread nodes and unions participant and
   parent relationships;
6. canonicalizes participant/thread identities and rewrites messages, tool
   executions, LLM attempts, document sources, and memory snapshots into their
   v3 graph and content-reference shapes;
7. imports legacy asset bodies through the caller's `resolveLegacyAsset`
   adapter, verifies their media encoding, size, and SHA-256 digest, and
   preserves explicitly unavailable assets as failed or abandoned records;
8. translates settled non-frame events into positioned immutable facts with no
   delivery obligations;
9. refreshes graph-native thread activity metadata; and
10. drops staged tables before commit.

The operation is tenant-independent and idempotent after success. Inline text,
reasoning, tool data, document sources, and memory snapshots become
database-backed assets. Existing external asset metadata cannot prove that its
body was preserved, so the migration requires an injected resolver whenever it
encounters such a record. A missing resolver, invalid resolver result, encoding
failure, or unexpected adapter failure rolls back that tenant's complete
upgrade. A resolver may explicitly classify a body that was already absent as
`failed` or `abandoned`; its node and content references remain intact, and
normal reads report that the asset is not ready. The migration module does not
import filesystem, object-storage, Deno, Node, or server APIs; the maintenance
adapter owns those concerns.

```ts
await upgradeV1Schemas(session, {
  schemas: ["tenant_a", "tenant_b"],
  resolveLegacyAsset: async ({ ref, mediaType }) => {
    const body = await legacyAssetAdapter.readIfPresent(ref!);
    return body
      ? { body, mediaType: mediaType ?? "application/octet-stream" }
      : {
        state: "failed",
        reason: "legacy body is no longer available",
        mediaType: mediaType ?? "application/octet-stream",
      };
  },
});
```

## Acceptance Evidence

- A20: clean four-table baseline, database immutability, sparse deliveries, and
  all-or-nothing graph/event/delivery writes.
- A21: commit-before-dispatch recovery, single-owner concurrent claims, expired
  leases, and idempotent output replay.
- A22: priority claims, heartbeat ownership, jittered retry, attempt exhaustion,
  dead letters, manual retry/discard, cancellation, and safe compaction.
- A23: descendant-only causal settlement and cancellation.
- A28: multi-tenant upgrade safety, domain/ID preservation, participant union,
  frame removal, positioned event translation, and rerun idempotency.
- A47/A55: passive-delivery growth invariants and runtime-neutral factory code.
