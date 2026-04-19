# APIs

API resources describe external REST APIs that Copilotz can integrate with.

## Where It Lives

API resources may be declared through loaded resource configuration instead of a
single fixed folder convention in every project.

## What It Is For

Use an API resource when you want Copilotz to understand and call a structured
external API surface.

Recommended use case: declarative external API integration  
Most common mistaken alternative: burying all external API knowledge in one-off
tool code without a reusable contract

## How Copilotz Consumes It

- API resources are loaded into runtime config
- the runtime can expose them to tools or generated integrations

## Minimal Example

Use a declarative API resource when the integration contract should be reusable
across tools, agents, or environments.

## Public Surface

API resources are runtime integrations rather than first-class dispatcher
routes.

## Related Pages

- [Tools](./tools.md)
- [MCP Servers](./mcp-servers.md)
- [createCopilotz](../reference/create-copilotz.md)
