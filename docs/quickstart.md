# Quickstart

The normal entry point is `createCopilotz()`. It creates a private Ominipg
database and private in-process Oxian host unless you inject application-owned
infrastructure.

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.61.0";
import { core } from "jsr:@copilotz/copilotz@^0.61.0/core";

const namespace = "acme";
const app = await createCopilotz({
  namespace,
  database: { url: ":memory:" },
  context: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Answer clearly and use tools when useful.",
        capabilities: {},
        runtime: {
          provider: "openai",
          model: "gpt-5-mini",
          apiKey,
        },
      },
    },
  },
});

await app.conversation.createThread({
  namespace,
  id: "thread-1",
  participants: [
    { id: "user-1", externalId: "user-1", participantType: "human" },
    {
      id: "support-1",
      externalId: "support",
      participantType: "agent",
      agentId: "support",
    },
  ],
});

const sent = await app.send(core.message({
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

const messages = await app.conversation.listMessages(namespace, "thread-1");
const answer = messages.at(-1);
if (answer) {
  console.log(
    await app.content.resolver.getMany(answer.content, { namespace }),
  );
}

await app.shutdown();
```

## What happened

1. The user message and its canonical content were committed with a
   `message.created` event.
2. Matching durable processors received sparse delivery obligations.
3. Oxian executed the text workflow. Provider attempts, tool executions, and
   public output became graph records and semantic events.
4. `run.done` settled only after the message's causal delivery scope completed.

## Add a plugin

Use plugins for reusable packages and explicit top-level context for
application-local values.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@^0.61.0/plugins";

const customerPlugin = definePlugin({
  id: "@acme/customer-support",
  version: "1.0.0",
  tools: [{
    id: "lookup_customer",
    key: "lookup_customer",
    name: "Lookup customer",
    description: "Fetch a customer by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    execute: async (input) => lookupCustomer(input),
  }],
});

const app = await createCopilotz({
  namespace: "acme",
  plugins: [customerPlugin],
  context: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Customer support",
        capabilities: { tools: ["lookup_customer"] },
      },
    },
  },
});
```

Installing a tool and granting it are separate. Omitted capabilities grant
nothing; see [agent capabilities](agent-capabilities.md) for exact and explicit
all-resource selections.

Next: [plugins and processors](plugins-and-processors.md) or
[persistent/realtime attachments](realtime-attachments.md).
