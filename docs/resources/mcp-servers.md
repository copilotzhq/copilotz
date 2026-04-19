# MCP Servers

MCP server resources register Model Context Protocol integrations that agents or
runtime components can use.

## What It Is For

Use an MCP server resource when you want Copilotz to integrate with an external
tooling or context server through MCP.

Recommended use case: external tool and context integration  
Most common mistaken alternative: treating every external capability as a custom
feature endpoint

## How Copilotz Consumes It

- MCP server config is loaded into the runtime
- agents and tools can use MCP-backed capabilities through the configured server

## Minimal Example

Declare MCP server config when the integration belongs to the runtime capability
surface rather than to a one-off HTTP call.

## Public Surface

MCP servers are runtime integrations, not standard app endpoints.

## Related Pages

- [Tools](./tools.md)
- [APIs](./apis.md)
- [createCopilotz](../reference/create-copilotz.md)
