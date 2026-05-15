---
title: Tools
description: Resource shape for agent-owned executable actions.
section: Resources
order: 30
status: stable
---

# Tools

Tools let agents execute actions.

## Code Shape

```ts
export default {
  id: "lookup_order",
  key: "lookup_order",
  name: "Lookup Order",
  description: "Find an order by id.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
    },
    required: ["orderId"],
  },
  execute: async ({ orderId }, context) => {
    return await context?.collections?.order.find({ id: orderId });
  },
};
```

## File Shape

```txt
resources/
  tools/
    lookup_order/
      config.ts
      execute.ts
```

## Runtime Behavior

1. the agent chooses a tool
2. Copilotz emits `TOOL_CALL`
3. the tool executes
4. Copilotz emits `TOOL_RESULT`
5. the result can be added to history
6. the agent can answer using the result

## Related Pages

- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
