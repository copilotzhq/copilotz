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

Tool pipelines let an agent compose tools without taking another LLM turn
between every operation. The syntax deliberately follows terminal conventions:

| Syntax                | Meaning                                      |
| --------------------- | -------------------------------------------- |
| New JSONL line        | Start an independent parallel lane           |
| `\|` on the same line | Pass the result to the next sequential stage |
| `{"jq":"..."}`        | Transform the current JSON value with jq     |

Inside `<tool_calls>`, join stages on the same line with `|`:

```xml
<tool_calls>
{"name":"extract","arguments":{"source":"crm"}} | {"jq":"{records:.items}"} | {"name":"analyze","arguments":{"mode":"deep"}}
{"name":"independent_tool","arguments":{}}
</tool_calls>
```

Every pipeline must begin with a tool. A later stage can be another tool or a jq
transform:

```text
tool ( | jq | tool | jq ... )
```

### Argument Merging

The output passed into a tool must be a JSON object. Copilotz deep-merges that
object into the later tool's explicit `arguments`:

- explicit arguments in the later stage win on conflicts
- nested objects merge recursively
- arrays and scalar values are replaced rather than combined

For example, if the piped value is:

```json
{ "customer": { "id": "123", "status": "new" }, "tags": ["imported"] }
```

and the later tool explicitly provides:

```json
{ "customer": { "status": "priority" }, "tags": ["manual"], "notify": true }
```

the tool receives:

```json
{
  "customer": { "id": "123", "status": "priority" },
  "tags": ["manual"],
  "notify": true
}
```

### Shaping Data with jq

A jq stage uses standard jq syntax to select or reshape the current JSON value.
Use it to adapt one tool's output to the next tool's input schema:

For example, wrap a text value in the property expected by the receiving tool:

```xml
<tool_calls>
{"name":"fetch_text","arguments":{"url":"https://example.com"}} | {"jq":"{content:.}"} | {"name":"summarize","arguments":{"style":"brief"}}
</tool_calls>
```

Each jq stage must produce exactly one value. Wrap filters that emit multiple
values in `[...]` to collect them into one array:

```xml
<tool_calls>
{"name":"list_orders","arguments":{}} | {"jq":"{orders:[.orders[] | select(.status == \"paid\")]}"} | {"name":"summarize_orders","arguments":{"currency":"USD"}}
</tool_calls>
```

If the value is a scalar or array before another tool, reshape it into an
object, for example `{"jq":"{content:.}"}`.

### Lifecycle and Failures

Copilotz persists every actual tool execution using the normal `tool_execution`
lifecycle. jq transforms are internal pipeline stages and do not create tool
execution records. Intermediate stages do not trigger new agent messages; only
the final result of each lane is returned to the agent.

A failed tool, invalid jq filter, jq timeout, multiple jq outputs, or non-object
input before a tool stops that lane. Other JSONL lanes can continue
independently. Pipeline failures are returned as tool failures so the agent can
recover or explain the problem.

### Current Scope

Pipelines intentionally support linear composition only. They do not currently
provide branching, cross-line dependencies, references to another lane's output,
or piping into terminal stdin. Use a tool or jq stage to convert data to JSON
before passing it onward.

## Related Pages

- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Chain Tools with Pipelines](../build-guides/chain-tools-with-pipelines.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
- [Live Pipeline Example](https://github.com/copilotz/copilotz/blob/main/examples/tool-pipeline-live.ts)
