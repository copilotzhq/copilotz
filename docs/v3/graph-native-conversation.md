---
title: Copilotz v3 Graph-Native Conversation
description: The participant, thread, and message vertical on immutable events and durable deliveries.
section: Internal Design
status: implementation
---

# Copilotz v3 Graph-Native Conversation

The first domain vertical stores participants, threads, and messages as native
graph nodes. Relationships are edges, semantic facts are immutable events, and
only processors that must perform guaranteed work receive delivery rows.

```text
participant ──participates_in──▶ thread ──has_message──▶ message
      │                                                   ▲
      └────────────────────sent_by────────────────────────┘

typed mutation
  └─ one transaction: nodes + edges + event + matched deliveries
                              │
                              └─ post-commit Oxian dispatch
```

There is no physical `threads` table and no public generic graph-write API in
this seam. SQL is confined to the typed repository implementation. Applications
and plugins use participant, thread, and message operations.

## Assembly

The repository is a factory-created capability. The engine assembly layer gives
it the event coordinator for writes and a narrow SQL session plus event-store
metadata for typed reads:

```ts
const conversation = createConversationRepository({
  coordinator,
  session,
  eventStore,
  assets,
});
```

`session` and `eventStore` are injected because the coordinator deliberately
does not expose undocumented storage internals. They are assembly capabilities,
not methods returned by the repository. The returned object exposes no raw SQL
or graph primitives.

## Aggregate Mutations

`createParticipant()` creates one participant node and `participant.created`.
Participant external identity is unique within a namespace.

`createThread()` can create or reuse its participant nodes inside the thread
aggregate transaction. It writes `participates_in` and optional
`has_child_thread` edges and emits one `thread.created` event. Subordinate
participant bookkeeping does not leak extra semantic events.

`createMessage()`:

1. accepts either existing canonical refs or a `PreparedContent` batch;
2. verifies the thread and addressed participant IDs in the same transaction;
3. creates or reuses the sender identity;
4. materializes new asset bodies or validates existing refs transactionally;
5. writes the message plus `has_message`, `sent_by`, `has_asset`, and
   participation edges;
6. emits one public `message.created` event; and
7. creates only the durable deliveries selected synchronously by the plugin
   registry.

The event payload is compact:

```ts
{
  type: "message.created",
  subject: { type: "message", id: messageId },
  payload: { messageId },
  routing: { senderId, recipientIds },
}
```

Text, JSON, media, and tool bodies are not duplicated into the event or the
message `content` column. The message node stores ordered asset references in
its structured data. Raw realtime frames remain outside this durable vertical.

## Ordering, Identity, and Recovery

- Reads are always namespace-scoped.
- Message ordering and cursors use immutable event positions rather than wall
  clocks.
- A mutation deduplication ID gives retries one semantic event and one domain
  node identity.
- A replay returns the existing projection. Settled deliveries are not
  dispatched again; pending deliveries remain recoverable.
- A replay prepared again with the same content idempotency keys resolves to the
  original asset refs; changed content fails as a conflict.
- Thread activity metadata is updated transactionally from the committed event.
- A missing thread, parent, sender constraint, or recipient rolls back graph
  state, the event, and all delivery obligations together.

## Current Boundary

This is additive and does not yet switch the current `createCopilotz()` runtime.
It establishes the direct event-native path that built-in message routing, agent
attempts, tools, memory, public `ask`, and attachments will consume. Each of
those verticals must pass its parity contracts before its legacy queue path is
removed.
