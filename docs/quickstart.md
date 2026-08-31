# Quickstart

`createCopilotz()` is the sole application factory. Omitting `role` creates an
embedded Gateway and Worker over a private in-process transport.

## Compose Core and one model

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.64.2";
import { corePlugin, message } from "jsr:@copilotz/copilotz@^0.64.2/core";

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
        models: { generate: ["fast"] },
        capabilities: {},
      },
    },
    models: {
      fast: {
        provider: "openai",
        model: "your-provider-model-id",
        apiKey,
      },
    },
  },
});
```

Resources are immutable process-local semantic definitions. Their declarative
fields are provider-neutral data; a Resource contract may also expose a typed,
read-only policy hook (for example, dynamic Agent instructions). Hooks run from
the composed Resource and are never persisted. A built-in Model Resource selects
its provider driver and captures credentials and transport configuration at
composition time. Neither the API key nor client is persisted in an Agent,
Action input, or lifecycle output. Custom providers use
`createLlmAdapter({ call })` from `/llm`; built-in providers need no Adapter
declaration or factory import.

When several Models use the same account, declare the credential once:

```ts
import { defineLlmCredential } from "jsr:@copilotz/copilotz@^0.64.2/llm";

const openai = defineLlmCredential({ provider: "openai", apiKey });

const resources = {
  llmCredentials: { openai },
  models: {
    fast: { provider: "openai", model: "fast-model", credentials: "openai" },
    strong: {
      provider: "openai",
      model: "strong-model",
      credentials: "openai",
    },
  },
};
```

`defineLlmCredential({ provider, resolve })` supports a tenant/user-scoped
connected account. The resolver receives a narrow trusted runtime context, runs
at most once for that credential alias in one `llm.call`, and returns either
ephemeral key/headers or `{ available: false }` so fallback skips the Model
without provider I/O. Resolver output is never persisted.

## Send typed ingress

Core messages target an existing thread and participant graph. Channel or
onboarding workflows may create that graph as part of their atomic ingress; a
trusted Gateway host can also bootstrap Collections through its
`/v3/collections/*` routes. The Goal runner consumes existing target and lead
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
import {
  createToolsPlugin,
  defineTool,
} from "jsr:@copilotz/copilotz@^0.64.2/tools";

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

const customerPlugin = createToolsPlugin({
  id: "@acme/customer-support",
  version: "1.0.0",
  tools: { lookup_customer: lookupCustomer },
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
`defineTool({ execute })` plus `createToolsPlugin` is intentionally a compiler
convenience: it creates the native Action and its data-only Tool Resource. Use
an Action, rather than a Resource hook, for work that needs retries, durable
provenance, or external side effects.
