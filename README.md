# Copilotz

Copilotz is an event-native multi-agent framework for durable text workflows and
realtime media streams. Applications communicate through thread attachments;
logical plugin resources execute as Oxian workloads; Ominipg stores graph state,
semantic events, and guaranteed delivery obligations.

```text
thread + participants
        │
   routed events
        │
 durable deliveries
        │
 plugin resources on Oxian
```

## Quick start

```ts
import createCopilotz from "jsr:@copilotz/copilotz@1";

const copilotz = await createCopilotz({
  agents: [{
    id: "support",
    name: "Support",
    role: "Resolve customer questions",
    runtimes: {
      text: { type: "llm", provider: "openai", model: "gpt-5-mini" },
    },
    llmOptions: { apiKey: "..." },
  }],
});

const run = await copilotz.run({
  content: "Where is my order?",
  sender: { externalId: "customer-42", type: "user" },
  target: "support",
});

for await (const event of run.events) {
  if (!event.durable && event.type === "text.delta") {
    console.log(event.payload);
  }
}
await run.done;
await copilotz.shutdown();
```

`run()` is a temporary attachment for simple text calls. Persistent and realtime
applications use `connect()` and one `attachment.send()` API for messages,
discrete controls, and `ReadableStream<Uint8Array>` media.

## Design invariants

- `nodes` and `edges` are canonical graph state. Thread, participant, message,
  LLM attempt, and tool execution are native node types.
- A mutation atomically commits its graph change, immutable event, and sparse
  durable delivery rows.
- The plugin registry selects logical consumers before commit. Oxian selects
  worker placement after commit.
- Durable execution is at-least-once. Collection mutations use delivery-scoped
  deduplication keys.
- Audio/token chunks are ephemeral Web Stream frames and never database rows.
- Public multi-agent `ask` questions and answers are ordinary participant
  messages.
- The core imports no unconditional Deno, Node, Bun, browser, or
  Cloudflare-specific API.

## Documentation

- [Architecture](docs/architecture.md)
- [Plugins and resources](docs/plugins-and-resources.md)
- [Events and processors](docs/events-and-processors.md)
- [Database and recovery](docs/database-and-recovery.md)
- [Embedding and hypervisors](docs/embedding-and-hypervisor.md)
- [Multi-agent `ask`](docs/multi-agent-ask.md)
- [Realtime attachments](docs/realtime-attachments.md)
- [API guide](docs/api.md)
- [v1 migration](docs/migration-v1.md)

This is a major-release architecture. Codec negotiation, provider-specific voice
activity detection, and video runtimes build on the stream foundation but are
not part of the core.
