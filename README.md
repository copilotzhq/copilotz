# Copilotz

Copilotz v3 is a factory-first framework for durable multi-agent applications.
It combines graph-native conversation state, immutable semantic events,
guaranteed processor deliveries, canonical content/assets, and realtime Web
Streams. Oxian places work; Ominipg persists state and recovery obligations.

```text
threads + participants
          │
    routed events
          │
 durable deliveries ── Oxian workers
          │
 plugin resources ─── agents, tools, processors, providers, channels…
```

## Install

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.58.0";
```

The root package is runtime-neutral. Host capabilities such as MCP stdio,
filesystem access, subprocesses, CLI terminal I/O, and HTTP mounting live on
explicit package subpaths.

## Minimal application

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.58.0";

const namespace = "example";
const copilotz = await createCopilotz({
  namespace,
  database: { url: ":memory:" },
  resources: {
    agents: [{
      id: "support",
      name: "Support",
      role: "Helpful support agent",
      capabilities: {}, // omission also grants no tools, agents, or skills
      llmOptions: {
        provider: "openai",
        model: "gpt-5-mini",
        apiKey,
      },
    }],
  },
});

await copilotz.conversation.createThread({
  namespace,
  id: "thread-1",
  participants: [
    { id: "user-1", externalId: "user-1", participantType: "human" },
    {
      id: "agent-support",
      externalId: "support",
      participantType: "agent",
      agentId: "support",
    },
  ],
});

const run = await copilotz.run({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["agent-support"],
  content: "Hello",
});

for await (const event of run.events) {
  console.log(event.type, event.correlationId);
}
await run.done;
await copilotz.shutdown();
```

`run()` is a convenience attachment for one text correlation scope. Long-lived
and realtime applications use `connect()` and `attachment.send()`; stream input
is passed once as a `ReadableStream<Uint8Array>` with native backpressure.

## Core guarantees

- Public runtime products are frozen records created by factories; architecture
  services are not classes.
- Every durable domain mutation atomically commits graph state, one immutable
  event, and the sparse delivery rows required by matched processors.
- Delivery is at-least-once. Built-in mutations deduplicate by delivery-derived
  operation keys, and tools receive an idempotency key.
- Raw token/audio/future media frames are ephemeral Web Streams. Final
  transcripts, messages, tools, errors, and stream lifecycle facts are durable.
- Plugins compose in deterministic order: core, declared plugins, then explicit
  application resources. Later resources replace earlier resources by type and
  stable ID.
- Installed resources do not create ambient agent authority. Exact
  `capabilities` grants are required; broad access uses explicit
  `{ all: true }`.
- Injected Ominipg sessions, Oxian Hypervisors, and dispatchers remain owned by
  the embedding application.
- Namespace and schema scope are explicit; no ambient runtime/database context
  is required.

## Package map

| Subpath                            | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `@copilotz/copilotz`               | Normal runtime-neutral application API                              |
| `/application`                     | Embedded, Gateway, and Worker role factories                        |
| `/plugins`, `/resources`           | Plugin composition and logical resource types                       |
| `/capabilities`                    | Explicit agent grants and canonical introspection                   |
| `/events`                          | Immutable events and durable delivery contracts                     |
| `/content`, `/domain`              | Canonical assets and graph-native repositories                      |
| `/attachments`, `/workflows`       | Text/realtime ingress, LLM/tools, and public agent ask              |
| `/skills`                          | Optional Open Skill resources and portable disclosure tools         |
| `/channels`, `/features`, `/admin` | App and transport resources                                         |
| `/adapters`                        | Runtime-neutral OpenAPI/MCP injection and Ominipg adapters          |
| `/adapters/stdio`                  | Explicit subprocess-backed MCP stdio capability                     |
| `/adapters/deno`, `/adapters/node` | Host-specific capabilities                                          |
| `/server`                          | Transitional v1 transport projection                                |
| `/migration/v1`                    | Isolated one-way database upgrade; never imported by normal runtime |

## Documentation

Start with [the v3 quickstart](docs/quickstart.md), then read:

- [Architecture](docs/architecture.md)
- [Plugins and processors](docs/plugins-and-processors.md)
- [Agent capabilities](docs/agent-capabilities.md)
- [Skills](docs/skills.md)
- [Events, deliveries, and recovery](docs/events-deliveries-recovery.md)
- [Content and assets](docs/content-assets.md)
- [Embedding and hypervisors](docs/embedding-and-hypervisors.md)
- [Multi-agent public ask](docs/multi-agent-ask.md)
- [Realtime attachments](docs/realtime-attachments.md)
- [API and package reference](docs/api.md)
- [Migrating from v0.x](docs/migration-v3.md)
- [v3 release notes](CHANGELOG.md)

The detailed implementation contracts and parity evidence live in
[docs/v3](docs/v3/README.md).

## Validation

```sh
deno task check
deno task test
deno task bundle:runtime-smoke
deno task smoke:deno
deno task smoke:node
deno task smoke:bun
deno task smoke:browser
deno task bundle:edge-smoke
deno task smoke:cloudflare
deno task smoke:cloudflare-build
deno task publish:dry-run
```

CI additionally runs the PostgreSQL migration/event matrix before publishing.

## License

MIT
