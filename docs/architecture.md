# Architecture

Copilotz separates durable meaning from execution placement.

```mermaid
flowchart TD
  A["Application or channel"] --> B["run() / persistent attachment"]
  B --> C["Typed graph/domain mutation"]
  C --> D["Atomic Ominipg transaction"]
  D --> E["nodes + edges"]
  D --> F["immutable event"]
  D --> G["sparse durable deliveries"]
  G --> H["Oxian dispatcher"]
  H --> I["plugin processor"]
  I --> C
  B <--> J["ephemeral Web Streams"]
```

## Domain model

A conversation is a thread plus participant graph. Messages, LLM attempts, tool
executions, assets, memories, knowledge records, schedules, and custom
collections are graph nodes with typed edges. Thread activity and ordering are
updated transactionally; there is no separate thread table.

## Event model

A durable event is an immutable fact with a ULID and database-assigned monotonic
position. An envelope is simply an event carrying routing, visibility,
causation, correlation, and subject metadata. Ephemeral deltas share the event
vocabulary but have no database ID or position.

Recipients are not persisted as work merely because they can observe an event.
Only matched durable processors create delivery rows. UI listeners, public
participants, channel observers, and raw media frames do not multiply database
work.

## Execution model

Oxian dispatches logical workload identities. Copilotz dispatch payloads contain
delivery/resource IDs, never serialized closures or physical worker identity.
The default application attaches one Copilotz worker to a private in-process
host. An embedding app may inject a shared host or a dispatcher/target owned by
its hypervisor.

## Plugin model

Everything extensible is a plugin resource: agents, tools, processors,
collections, providers, channels, skills, memory, APIs, MCP servers, features,
and storage capabilities. Composition is deterministic:

1. built-in core plugins
2. declared plugins in order
3. explicit application resources

A later resource with the same type and stable ID replaces the earlier one.

## Stream model

Text and realtime share the attachment boundary. Discrete input becomes a
semantic event; raw audio or future media enters once as a Web `ReadableStream`.
Backpressure remains end-to-end through Oxian. Only stream lifecycle facts and
final semantic outcomes are persisted.

## Factory-first boundary

Public runtime objects are frozen records returned by factories. Stateful
behavior is held in closures. Narrow `Error` subclasses may exist for error
identity, but managers/stores/services are not public architecture classes.

For implementation-level detail, see [the v3 design index](v3/README.md).
