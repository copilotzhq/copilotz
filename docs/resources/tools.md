# Tools

Tools are agent-callable actions loaded from `resources/tools/...`.

## Where It Lives

```txt
resources/tools/<tool-name>/
```

## What It Is For

Use a tool when the model should decide whether and when to call an action.

Recommended use case: agent-owned runtime action  
Most common mistaken alternative: using a feature endpoint for model-internal
behavior

## How Copilotz Consumes It

- tools are loaded into the runtime tool registry
- agents can call them during execution
- tools receive `ToolExecutionContext` for thread, db, collections, assets, and
  sender state

## Minimal Example

```ts
export default {
  key: "getWeather",
  description: "Get weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};
```

## Public Surface

Tools are runtime-facing, not endpoint-facing by default.

## Related Pages

- [Add Agent Capabilities with Tools](../playbooks/add-agent-capabilities-with-tools.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
- [Processors](./processors.md)
