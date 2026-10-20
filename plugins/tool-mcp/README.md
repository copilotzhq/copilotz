# MCP

Declare `await defineMcp({id,name,connection,tools?})` under `resources.mcp`.
One awaited call discovers and validates tools and returns a resource with
default runtime bindings. See
[APIs and tools](../../docs/getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md).

### External-effect safety

Generated MCP Actions record an external effect before `callTool`. Confirmed
outcomes replay without another call; ambiguous calls require reconciliation and
are not automatically resent. A host can declare reviewed read-only tool names
with `readOnlyTools: ["lookup"]` on `defineMcp`. Those calls retain ordinary
retry behavior. Provider `readOnlyHint` annotations alone are not trusted to
grant it.
