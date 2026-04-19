# How the Graph Works

The graph is the durable substrate underneath Copilotz collections, messages,
participants, and relationships.

## What the Graph Does

The graph stores nodes and edges so Copilotz can represent:

- participants and messages
- collection-backed records
- relationships between entities
- retrieval and memory context

## Recommended Use Case

Treat collections and participant APIs as the primary app-facing abstraction.
Understand the graph so you can reason about durability and relationships, not
because most apps should manipulate raw graph data first.

## Common Mistaken Alternative

Do not skip collections and build everything directly on raw graph operations
unless you truly need graph-native behavior.

## Public Surface

Copilotz also exposes graph helpers and routes, but collections remain the
recommended abstraction for most application data.

## Related Pages

- [Persist Data with Collections](../playbooks/persist-data-with-collections.md)
- [Collections API](../reference/collections-api.md)
- [Namespaces and Multi-Tenancy](./namespaces-and-multi-tenancy.md)
