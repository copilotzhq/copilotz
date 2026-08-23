# Copilotz Documentation

These guides describe the executable 0.62 public surface. Historical design
plans and removed migration APIs are intentionally not published.

## Start here

1. [Quickstart](quickstart.md)
2. [Architecture](architecture.md)
3. [API and package reference](api.md)
4. [Plugins and processors](plugins-and-processors.md)

## Runtime mechanics

- [Events, deliveries, and recovery](events-deliveries-recovery.md)
- [Content and assets](content-assets.md)
- [Progressive streams](streams.md)
- [Embedding, Gateways, and Workers](embedding-and-hypervisors.md)
- [Host capability adapters](runtime-adapters.md)

## Semantic plugins

- [Agent capabilities](agent-capabilities.md)
- [Multi-agent ask](multi-agent-ask.md)
- [Semantic memory](memory.md)
- [Skills](skills.md)

## Database upgrade

- [Migrate the exact 0.47/0.48 legacy graph to v4](migration-v4.md)

`../ARCHITECTURE.md` is the first-principles architecture authority. The
package's actual public entrypoints are the `exports` in `../deno.json`.
