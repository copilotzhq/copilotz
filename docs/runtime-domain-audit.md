# Runtime domain boundary audit

The runtime carries generic Events, Collections, Actions, resources, adapters,
operations and streams. Core and other plugins own their domain policies.

## Resolved findings

| Previous runtime leak                                                     | Current owner and implementation                                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event `threadId`, filtering and `events.thread_id`                        | Core's `metadata.core.threadId`; runtime filters bounded opaque metadata with JSON containment.                                                                                               |
| Thread-specific operation catalog methods                                 | [Core operation queries](../plugins/core/authoring/operations/index.ts), consumed by the server after thread authorization. The catalog exposes generic SQL/session and operation operations. |
| Public/participant/tool/internal visibility union                         | [Core event policy](../plugins/core/authoring/events/index.ts); runtime stores opaque metadata. Message history projection remains participant-aware in Core.                                 |
| Sender and recipient event routing                                        | Core's `metadata.core.routing`; durable delivery scheduling remains generic runtime infrastructure.                                                                                           |
| Tool, reasoning and conversation content role suggestions                 | Core authoring suggestions; runtime accepts an opaque role string.                                                                                                                            |
| Conversational ephemeral event type suggestions                           | Core authoring suggestions; runtime accepts an arbitrary non-empty type.                                                                                                                      |
| Mandatory physical `nodes.embedding` JSON column and Memory record arrays | Removed from the fresh schema and Memory record schema. [Optional vector storage](vector-storage-refactor.md) uses pgvector.                                                                  |

Core policy metadata is written explicitly by its primitives. Generic runtime
matching, durable replay and ephemeral subscriptions do not import or identify a
plugin. Collection writes accept generic metadata, alongside mutation identity.

Runtime schema v5 removes the three conversation columns and the unused
embedding column. Metadata GIN and namespace/position indexes support generic
event queries. Provisioning rejects incompatible schemas without changing their
data. There is no migration, backfill, old JSON-vector reader, or compatibility
wrapper.

The runtime source contract rejects conversational field/type names and
`Object.freeze`. Snapshot boundaries still clone caller-owned data; subscribers
receive independent event snapshots. Core tests cover private Agent turns,
participant-limited failures, Tool continuations and history projection. Generic
runtime tests use an explicit test-only primitive subset instead of installing
conversation processors accidentally.

## Scope

This is a library refactor. Application changes and deployments for Compass,
Mobizap and Pricing Agent remain separate milestones. Knowledge's own retrieval
strategy remains plugin-owned; this milestone changes Memory vector retrieval.
