# Tool Execution Context

`ToolExecutionContext` is the runtime context passed to custom tool `execute`
handlers.

## Common Fields

- `namespace`
- `threadId`
- `senderId`
- `senderType`
- `db`
- `collections`
- `assetStore`

## Why It Matters

The tool context is what lets a tool act like part of the runtime instead of a
free-floating function.

## Recommended Use Case

Read and write data through the provided namespaced context instead of reaching
around it through unrelated globals.

## Common Mistaken Alternative

Do not assume the tool can infer the correct namespace or thread state without
using the provided context.

## Related Pages

- [Tools](../resources/tools.md)
- [Add Agent Capabilities with Tools](../playbooks/add-agent-capabilities-with-tools.md)
- [Test a Real Copilotz App](../playbooks/test-a-real-copilotz-app.md)
