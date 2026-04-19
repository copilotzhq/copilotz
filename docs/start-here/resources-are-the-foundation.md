# Resources Are the Foundation

Resources are the primary building blocks of a Copilotz application. They are
declared on disk, loaded by `createCopilotz(...)`, and consumed by the runtime
to create application behavior.

## Why Resources Matter

Resources give Copilotz its structure. Instead of wiring every behavior through
manual configuration or custom route code, you define resources in a known
directory layout and let the runtime compose them.

This is what makes Copilotz:

- consistent for humans
- easy for agents to navigate
- reusable across transports
- testable through the same runtime contracts

## Resource Types

Common resource types include:

- agents
- tools
- features
- collections
- processors
- channels
- llm providers
- embeddings providers
- storage adapters
- skills
- apis
- mcp servers

## Resource to Runtime Mapping

| Resource | Main Purpose | Consumed By | Public Surface |
| --- | --- | --- | --- |
| `features` | app-facing backend actions | app dispatcher | `/features/:name/:action` |
| `tools` | agent-callable actions | agent runtime | tool calls during runs |
| `collections` | durable app data | collections manager and runtime | `/collections/:name` |
| `agents` | orchestration and instructions | run engine | agent execution |
| `processors` | background/event work | event engine | event lifecycle |
| `channels` | ingress and egress | channel runtime | external transports |

## Directory Shape

The canonical project layout is:

```txt
resources/
  agents/
  tools/
  features/
  collections/
  processors/
  channels/
  llm/
  embeddings/
  storage/
  skills/
```

## Recommended Use Case

Start every implementation by asking which resource should own the behavior.
That usually answers where the code should live, how it will be loaded, and how
it should be tested.

## Common Mistaken Alternative

Do not start from transport-specific route handlers unless the transport itself
is the core concern. In most cases, the route should be a thin wrapper around a
resource-backed runtime capability.

## Related Pages

- [Choose the Right Primitive](./choose-the-right-primitive.md)
- [Resources](../resources/README.md)
- [How Resource Loading Works](../runtime/how-resource-loading-works.md)
