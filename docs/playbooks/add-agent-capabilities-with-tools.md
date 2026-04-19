# Add Agent Capabilities with Tools

## When to Use This

Use a `tool` when the model or agent should decide when to call an action during
execution.

Recommended primitive: `tool`  
Most common mistaken alternative: building agent-owned behavior as a feature
endpoint first

## Minimal Project Layout

```txt
resources/
  tools/
    summarizeCustomer/
      index.ts
      execute.ts
```

## Example Implementation

```ts
export default {
  key: "summarizeCustomer",
  description: "Summarize the current customer record",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string" },
    },
    required: ["customerId"],
  },
};
```

```ts
export default async function execute(input, context) {
  const customers = context.collections?.withNamespace(context.namespace).customer;
  const record = await customers.findOne({ id: input.customerId });
  return { summary: `Customer ${record?.id}` };
}
```

## How Copilotz Consumes It

- the resource loader loads tools from `resources/tools/...`
- tool metadata becomes part of the agent runtime config
- the run engine can invoke the tool during execution when the agent is allowed
  to use it

## How It Maps to Runtime Behavior

Tools are not app endpoints by default. They are exposed to the agent runtime as
callable actions and execute with `ToolExecutionContext`.

## Validation Checklist

- the tool is loaded into `copilotz.config.tools`
- the agent is allowed to use the tool
- the tool returns serializable output
- the tool reads and writes through namespaced runtime dependencies
- the behavior is tested either through a real run or direct `tool.execute(...)`

## Related Pages

- [Tools](../resources/tools.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
- [Test a Real Copilotz App](./test-a-real-copilotz-app.md)
