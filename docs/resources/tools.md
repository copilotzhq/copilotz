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

## Tool Pipelines

Inside `<tool_calls>`, each JSONL line is an independent parallel lane. Join
stages on the same line with `|` to execute them sequentially:

```xml
<tool_calls>
{"name":"extract","arguments":{"source":"crm"}} | {"jq":"{records:.items}"} | {"name":"analyze","arguments":{"mode":"deep"}}
{"name":"independent_tool","arguments":{}}
</tool_calls>
```

The output of each tool becomes the input to the next stage. A `jq` stage uses
standard jq syntax to select or reshape JSON. Before the next tool executes,
Copilotz deep-merges the piped object into that tool's explicit arguments.
Explicit arguments win; nested objects merge recursively, while arrays and
scalar values are replaced.

If a tool or jq stage returns a scalar, shape it into an argument object before
the next tool:

```xml
<tool_calls>
{"name":"fetch_text","arguments":{"url":"https://example.com"}} | {"jq":"{content:.}"} | {"name":"summarize","arguments":{"style":"brief"}}
</tool_calls>
```

Each jq stage must produce exactly one value. Wrap filters that emit multiple
values in `[...]` to collect them into one array. A failed stage stops only its
own lane. Copilotz persists every actual tool execution but returns only the
final lane result to the agent, avoiding intermediate LLM turns.

## Related Pages

- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
