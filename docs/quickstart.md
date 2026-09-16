# Quickstart

`createCopilotz()` is the sole application factory. Omitting `role` creates an
embedded Gateway and Worker over a private in-process transport.

## Compose Core and one model

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.74.1";
import { corePlugin, message } from "jsr:@copilotz/copilotz@^0.74.1/core";

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
        models: {
          generate: [{ connection: "openai", model: "your-provider-model-id" }],
        },
        capabilities: {},
      },
    },
    llmConnections: {
      openai: {
        provider: "openai",
        auth: { apiKey },
      },
    },
  },
});
```

Resources are process-local definitions. The connection owns provider, endpoint,
and authentication. Agents and direct `llm.call` inputs own model IDs and JSON
options. Keys, resolved headers, and provider clients never enter persisted
Action inputs or lifecycle outputs.

One connection supports multiple models and reasoning levels:

```ts
import { defineLlmConnection } from "@copilotz/copilotz/llm";

const openai = defineLlmConnection({ provider: "openai", auth: { apiKey } });
const resources = { llmConnections: { openai } };
const models = {
  generate: [
    {
      connection: "openai",
      model: "your-model",
      options: { reasoningEffort: "high" },
    },
    { connection: "openai", model: "your-fallback-model" },
  ],
};
```

For dynamic authentication, use `auth: { resolve(context, execution) { ... } }`.
The resolver receives trusted scope and collection access and returns ephemeral
`{ available: true, apiKey, extraHeaders? }` or `{ available: false }`.
Resolution is lazy and memoized per connection within one call. Provider
failures retain the existing ordered fallback behavior. Transport/authentication
fields are rejected in durable selections and their options.

`createChatGptConnection` from `/llm` handles access-token expiry, refresh and
in-process refresh sharing for an already connected ChatGPT account. Supply an
explicit OAuth client ID and `load`, `save`, and `markExpired` callbacks. The
application owns user/account authorization, encrypted storage, and conditional
writes. See
[the helper contract](../plugins/llm/authoring/chatgpt-connection/README.md).
Custom providers use `createLlmAdapter({ call })` and a connection
`{ adapter }`.

## Send typed ingress

Core messages target an existing thread and participant graph. Channel or
onboarding workflows may create that graph as part of their atomic ingress; a
trusted Gateway host can also bootstrap Collections through its
`/api/collections/*` routes. The Goal Action consumes existing target and lead
threads rather than provisioning them.

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
import { defineTool } from "jsr:@copilotz/copilotz@^0.74.1/tools";

const lookupCustomer = defineTool({
  id: "acme.customer.lookup",
  name: "Lookup customer",
  description: "Fetch a customer by ID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(input: Readonly<{ id: string }>) {
    return await lookupCustomerById(input.id);
  },
});

import { definePlugin } from "@copilotz/copilotz/plugins";
const customerPlugin = definePlugin({
  id: "@acme/customer-support",
  version: "1.0.0",
  resources: { tools: { lookup_customer: lookupCustomer } },
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
`defineTool({ execute })` is a synchronous Composition Contribution: it creates
the native Action and its data-only Tool Resource. Use an Action, rather than a
Resource hook, for work that needs retries, durable provenance, or external side
effects.
