---
name: create-tool
description: Define an agent workflow tool as a plugin resource.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, tool, plugin]
---

# Create Tool

Tools are logical plugin resources. Their implementation executes inside the
worker with a workflow-owned, tenant-scoped context.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "jsr:@copilotz/copilotz@3/workflows";

const lookupCustomer: WorkflowTool = {
  id: "lookup_customer",
  key: "lookup_customer",
  name: "Lookup customer",
  description: "Get a customer by stable customer ID.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  historyPolicy: { visibility: "requester_only" },
  async execute(raw, context?: WorkflowToolExecutionContext) {
    if (!context) throw new Error("Event-native tool context is required.");
    const { id } = raw as { id: string };
    return await context.collections.customer.get(id);
  },
};

export default definePlugin({
  manifest: {
    id: "@acme/customer-tools",
    version: "1.0.0",
    provides: { tools: [lookupCustomer.key] },
  },
  resources: { tools: [lookupCustomer] },
});
```

The context includes namespace, correlation and idempotency IDs, execution
identity, agent/team resources, scoped collections, content resolution,
`AbortSignal` through `context.processor.signal`, and cancellation hooks. It
does not expose unrestricted SQL.

For external mutations, propagate `context.idempotencyKey`. Use canonical
content/assets for large inputs or results. Agent access is controlled by
`allowedTools`; `undefined` allows all composed tools, while an empty/null list
allows none.
