# Quickstart

`createCopilotz()` is the sole application factory. Omitting `role` creates an
embedded Gateway and Worker over a private in-process transport.

## Compose Core and one model

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.62.0";
import { corePlugin, message } from "jsr:@copilotz/copilotz@^0.62.0/core";
import { createOpenAiAdapter } from "jsr:@copilotz/copilotz@^0.62.0/llm";

const apiKey = Deno.env.get("OPENAI_API_KEY");
if (!apiKey) throw new Error("OPENAI_API_KEY is required.");

const app = await createCopilotz({
  namespace: "acme",
  database: { url: ":memory:" },
  plugins: [corePlugin],
  resources: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Answer clearly and use only granted capabilities.",
        models: { generate: "fast" },
        capabilities: {},
      },
    },
    models: {
      fast: {
        adapter: "openai",
        model: "your-provider-model-id",
      },
    },
  },
  adapters: {
    llm: {
      openai: createOpenAiAdapter({
        apiKey,
      }),
    },
  },
});
```

The Model Resource is durable, provider-neutral data. The Adapter captures the
credential and transport at composition time. Neither the API key nor client is
persisted in an Agent, Action input, or lifecycle output.

## Send typed ingress

Core messages target an existing thread and participant graph. Channel and Goal
plugins create that graph as part of their atomic ingress; a trusted Gateway
host can also bootstrap Collections through its `/v3/collections/*` routes.

```ts
const operation = await app.send(message({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["agent-support"],
  content: "How can you help me?",
  deduplicationId: "demo:thread-1:message-1",
}));

for await (const output of operation.outputs) {
  if (output.type === "stream.output") {
    for await (const bytes of output.payload) consume(bytes);
  } else {
    console.log(output.type, output.subject);
  }
}

await operation.done;
await app.close();
```

The output stream is installed before ingress is appended. `done` resolves only
after the operation's durable settlement scope reaches zero and relayed output
is drained. Detached Processors remain durable but do not delay this handle.

## Add a native Tool

```ts
import { defineAction } from "jsr:@copilotz/copilotz@^0.62.0/actions";
import { definePlugin } from "jsr:@copilotz/copilotz@^0.62.0/plugins";
import { defineTool } from "jsr:@copilotz/copilotz@^0.62.0/tools";

const lookupCustomer = defineAction({
  id: "acme.customer.lookup",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(input: Readonly<{ id: string }>) {
    return await lookupCustomerById(input.id);
  },
});

const customerPlugin = definePlugin({
  id: "@acme/customer-support",
  version: "1.0.0",
  actions: { lookup_customer: lookupCustomer },
  resources: {
    tools: {
      lookup_customer: defineTool("lookup_customer", lookupCustomer, {
        name: "Lookup customer",
        description: "Fetch a customer by ID.",
      }),
    },
  },
});
```

Install `customerPlugin`, then grant the exact alias on the Agent:

```ts
capabilities: {
  tools: ["lookup_customer"];
}
```

Installing a Tool does not grant it. The Tool Resource describes one existing
Action alias; Core invokes that Action directly, so there is one lifecycle.
