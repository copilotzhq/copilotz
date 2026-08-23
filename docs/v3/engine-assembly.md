---
title: Runtime Assembly and Ownership
description: Operational ownership of persistence and durable execution behind createCopilotz.
section: Internal Design
status: implementation
---

# Runtime Assembly and Ownership

[`ARCHITECTURE.md`](../../ARCHITECTURE.md) is the authority for runtime and
plugin boundaries. Runtime assembly is private implementation behind the one
public `createCopilotz()` composition path.

## Public composition root

`createCopilotz()` receives the caller's Plugins, Resource overlays, Adapter
overlays, deployment role, and runtime infrastructure. It returns the generic
application boundary: `send`, `observe`, and `close`. Internal stores,
coordinators, executors, and workload maps are not plugin or application APIs.

Plugin dependencies compose before their declaring plugin. Root plugins then
compose in caller order, followed by application Resource and Adapter overlays.
The resulting registries are immutable for that application instance.

## Infrastructure ownership

The application retains ownership of infrastructure it injects, including a
database, shared execution host, or dispatcher. Closing Copilotz releases only
runtime-owned or runtime-attached work; it does not close caller-owned
infrastructure.

Schema provisioning is deployment control flow, not request processing. A new
physical schema must be provisioned before it can be selected. Schema scopes may
be created lazily while sharing the application's database and execution
infrastructure.

The runtime owns no resident semantic timer. A scheduling plugin receives typed
tick or manual-run envelopes through `send`, just like any other plugin input.

## Durable execution boundary

Durable work payloads carry stable identifiers and routing metadata, not
repository instances, contexts, or closures. A worker resolves the relevant
scope and reconstructs the same composed `RuntimeContext` used by local
execution. The Processor receives its resolved immutable Event separately as the
first `handle` argument.

Plugin context includes composed Actions, Collections, Resources, and Adapters
plus generic runtime primitives such as transactions, content, required streams
and cancellation, identity, and time. It excludes raw storage/database access,
executor internals, Event stores, delivery services, and schedule services.

Graph mutations, Event Bodies, Events, and delivery obligations commit
atomically. Declared content is prepared before SQL and its Bodies, Assets, and
ownership projections are adopted inside that commit. Dispatch begins only after
the commit succeeds. Recovery operates on durable delivery obligations; it does
not encode plugin business meaning.
