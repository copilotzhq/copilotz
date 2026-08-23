# Quickstart

The normal entry point is `createCopilotz()`. It creates a private Ominipg
database and private in-process Oxian host unless you inject application-owned
infrastructure.

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.61.0";
import { corePlugin, message } from "jsr:@copilotz/copilotz@^0.61.0/core";

const namespace = "acme";
const app = await createCopilotz({
  namespace,
  database: { url: ":memory:" },
  plugins: [corePlugin],
  resources: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Answer clearly and use tools when useful.",
        models: { generate: "default" },
        capabilities: {},
      },
    },
    models: {
      default: { adapter: "default", model: "gpt-5-mini" },
    },
  },
  adapters: { llm: { default: myLlmAdapter } },
});

// The channel or onboarding flow has already created this thread and its
// user/agent participants.
const sent = await app.send(message({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["support-1"],
  content: "How can you help me?",
}));

for await (const output of app.observe()) {
  console.log(output.type, output.correlationId);
  if (output.correlationId === sent.correlationId) break;
}
await sent.done;

await app.close();
```

## What happened

1. The user message and its canonical content were committed with a
   `message.created` event.
2. Matching durable processors received sparse delivery obligations.
3. Oxian executed the text workflow. LLM and Tool Actions emitted their ordinary
   durable lifecycle Events, while public output became a Message graph record.
4. `sent.done` settled only after the message's causal delivery scope completed.

## Add a plugin

Use plugins for reusable packages and explicit Resource or Adapter overlays for
application-local values.

```ts
import { defineAction } from "jsr:@copilotz/copilotz@^0.61.0/actions";
import { corePlugin } from "jsr:@copilotz/copilotz@^0.61.0/core";
import { definePlugin } from "jsr:@copilotz/copilotz@^0.61.0/plugins";
import { defineTool } from "jsr:@copilotz/copilotz@^0.61.0/tools";

const lookupCustomer = defineAction({
  id: "acme.customer.lookup",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: async (input: Readonly<{ id: string }>) =>
    await lookupCustomerById(input.id),
});

const lookupCustomerTool = defineTool("lookup_customer", lookupCustomer, {
  name: "Lookup customer",
  description: "Fetch a customer by ID.",
});

const customerPlugin = definePlugin({
  id: "@acme/customer-support",
  version: "1.0.0",
  actions: { lookup_customer: lookupCustomer },
  resources: { tools: { lookup_customer: lookupCustomerTool } },
});

const app = await createCopilotz({
  namespace: "acme",
  plugins: [corePlugin, customerPlugin],
  resources: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Customer support",
        models: { generate: "default" },
        capabilities: { tools: ["lookup_customer"] },
      },
    },
    models: {
      default: { adapter: "default", model: "gpt-5-mini" },
    },
  },
  adapters: { llm: { default: myLlmAdapter } },
});
```

Installing a Tool Resource and its matching Action is separate from granting its
Action alias to an Agent. Omitted capabilities grant nothing; see
[agent capabilities](agent-capabilities.md) for exact alias selections.

Next: [plugins and processors](plugins-and-processors.md) or
[persistent/realtime attachments](realtime-attachments.md).
