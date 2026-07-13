---
title: Chain Tools with Pipelines
description: Compose tool calls with terminal-style pipes and jq transforms.
section: Build Guides
order: 35
status: stable
---

# Chain Tools with Pipelines

Use a tool pipeline when the output of one tool should feed another tool without
an extra LLM turn between them.

This guide builds a three-stage flow:

```text
load_sales_data | jq | analyze_sales
```

The first tool returns raw records, jq selects and reshapes them, and the final
tool receives the transformed data plus its own explicit arguments.

## Define Structured Tools

Pipeline tools are ordinary Copilotz tools. Return JSON-compatible structured
data and describe the receiving schema precisely:

```ts
import { createCopilotz, type Tool } from "@copilotz/copilotz";

const loadSalesData: Tool = {
  id: "load_sales_data",
  key: "load_sales_data",
  name: "Load Sales Data",
  description: "Load sales orders for a region.",
  inputSchema: {
    type: "object",
    properties: { region: { type: "string" } },
    required: ["region"],
  },
  execute: ({ region }) => ({
    region,
    orders: [
      { id: "A-100", status: "paid", amount: 120.25 },
      { id: "A-101", status: "pending", amount: 80 },
    ],
  }),
};

const analyzeSales: Tool = {
  id: "analyze_sales",
  key: "analyze_sales",
  name: "Analyze Sales",
  description: "Summarize a prepared list of sales orders.",
  inputSchema: {
    type: "object",
    properties: {
      orders: { type: "array", items: { type: "object" } },
      sourceRegion: { type: "string" },
      currency: { type: "string" },
    },
    required: ["orders", "sourceRegion", "currency"],
  },
  execute: ({ orders, sourceRegion, currency }) => ({
    sourceRegion,
    currency,
    count: orders.length,
    total: orders.reduce((sum, order) => sum + order.amount, 0),
  }),
};
```

## Guide the Agent

Make both tools available and tell the agent when sequential composition is
appropriate. Copilotz's tool system prompt teaches the pipeline syntax; agent
instructions should describe the task rather than reproduce the whole wire
protocol.

```ts
const copilotz = await createCopilotz({
  agents: [{
    id: "sales-analyst",
    name: "Sales Analyst",
    role: "assistant",
    instructions: `
      Load sales for the requested region. In one pipeline, use jq to retain
      only paid orders and map region to sourceRegion, then analyze the result
      in USD. Answer from the final analysis.
    `,
    allowedTools: ["load_sales_data", "analyze_sales"],
    llmOptions: { provider: "openai", model: "gpt-5.4" },
  }],
  tools: [loadSalesData, analyzeSales],
  dbConfig: { url: ":memory:" },
});
```

The agent can emit:

```xml
<tool_calls>
{"name":"load_sales_data","arguments":{"region":"south"}} | {"jq":"{orders:[.orders[] | select(.status == \"paid\")],sourceRegion:.region}"} | {"name":"analyze_sales","arguments":{"currency":"USD"}}
</tool_calls>
```

Copilotz executes the stages from left to right. The final tool receives:

```json
{
  "orders": [{ "id": "A-100", "status": "paid", "amount": 120.25 }],
  "sourceRegion": "south",
  "currency": "USD"
}
```

The `currency` property comes from the later stage's explicit arguments. If jq
also produced `currency`, the explicit value would win.

## Parallel and Sequential Work

One line is one sequential lane. Add another JSONL line when work is
independent:

```xml
<tool_calls>
{"name":"load_sales_data","arguments":{"region":"south"}} | {"jq":"{orders:.orders}"} | {"name":"analyze_sales","arguments":{"currency":"USD"}}
{"name":"get_exchange_rate","arguments":{"from":"USD","to":"BRL"}}
</tool_calls>
```

The two lines can run in parallel. Stages joined by `|` wait for the previous
stage in their own lane.

## Debug a Pipeline

Inspect the root `TOOL_CALL` event to see the parsed plan:

```ts
for await (const event of result.events) {
  if (event.type !== "TOOL_CALL") continue;
  const { toolCall } = event.payload;
  console.log(toolCall.pipeline?.stages);
}
```

When debugging, check these common failures:

- The pipeline must begin with a tool, not jq.
- A value passed into a tool must be an object.
- jq must produce exactly one value; use `[...]` to collect a stream.
- The receiving tool's explicit arguments must still satisfy its input schema.
- A failure stops its lane before downstream tools execute.

Each actual tool stage is stored as a durable `tool_execution`. jq stages are
not tool executions, and intermediate results do not cause extra LLM turns.

## Run the Live Example

The repository includes a real-model E2E example with assertions for parsing,
jq, deep merging, durable execution, and the final answer:

```bash
deno run -A --env examples/tool-pipeline-live.ts
```

See
[`examples/tool-pipeline-live.ts`](https://github.com/copilotz/copilotz/blob/main/examples/tool-pipeline-live.ts).

## Related Pages

- [Tools](../resources/tools.md)
- [Create a Custom Tool](./create-custom-tool.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
