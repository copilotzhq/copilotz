# Copilotz

Copilotz is a plugin-first, event-sourced runtime for durable AI applications.
The runtime owns generic mechanics; plugins own business meaning.

```mermaid
flowchart LR
  input["plugin input"] --> send["application.send"]
  send --> event[("immutable Event")]
  event --> processor["Processor"]
  processor --> action["Action"]
  processor --> collection["Collection mutation"]
  action --> event
  collection --> event
```

Plugins contribute five primitives:

- Collections: durable semantic state and relations.
- Actions: executable capabilities with one durable lifecycle.
- Processors: event-driven orchestration.
- Resources: process-local agents, models, tools, skills, configuration, and
  policy.
- Adapters: application-owned custom external implementations.

Messages, agents, models, tools, and channels belong to their semantic plugins.
Goals are a small Core authoring loop over ordinary application sends. The
generic runtime contains no provider catalog, Tool executor, conversation DTO,
or hidden workflow controller.

## Convention-first authoring

Use static plugins, configure capabilities through the final context, and run
`copilotz build` on the development or CI host. See the
[authoring guide](docs/convention-authoring.md) for discovery, file structure,
validation, ESM generation, and migration from removed plugin factories.

## Install

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.76.5";
```

Host-only capabilities live on explicit subpaths. Importing the root does not
pull in filesystem, subprocess, terminal, MCP stdio, or provider credentials.

## Compose an AI application

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@^0.76.5";
import { corePlugin, message } from "jsr:@copilotz/copilotz@^0.76.5/core";

const openAiKey = Deno.env.get("OPENAI_API_KEY");
if (!openAiKey) throw new Error("OPENAI_API_KEY is required");

const app = await createCopilotz({
  namespace: "acme",
  database: { url: ":memory:" },
  plugins: [corePlugin],
  resources: {
    agents: {
      support: {
        id: "support",
        name: "Support",
        role: "Answer clearly and use only explicitly granted capabilities.",
        models: {
          generate: [{ connection: "openai", model: "provider-model-id" }],
        },
        capabilities: {},
      },
    },
    llmConnections: {
      openai: {
        provider: "openai",
        auth: { apiKey: openAiKey },
      },
    },
  },
});

// A Channel, onboarding flow, or trusted Gateway route has already
// created this thread and its human/agent participants.
const operation = await app.send(message({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["agent-support"],
  content: "How can you help me?",
}));

for await (const output of operation.outputs) {
  console.log(output.type, output.correlationId);
}
await operation.done;
await app.close();
```

`send()` accepts one plugin-owned input envelope. It returns a durable operation
identity, its ingress Event and correlation identities, an opaque replay cursor,
a local output attachment, and settlement controls. `detach()` stops only that
observer; `cancel()` is an explicit durable cancellation. `attach()` can resume
the same operation from any Gateway replica, while `operationStatus()`,
`listOperations()`, and `cancelOperation()` provide the generic host policy
seams. `observe()` remains an independent process-local application-wide
subscription. Gateway adds `fetch`; Worker returns `{ ready, closed, close }`.

For multi-turn evaluation, Core’s `runGoal` Action alternates settled target and
lead sends through a context-supplied conversation Adapter. Policy lives in a
Resource; progress and cancellation use the Action lifecycle. See
[Goal Action](./docs/goals.md).

## Core guarantees

- Collection state, Event Bodies, immutable Events, and required delivery
  obligations commit atomically.
- Durable Processor execution is at least once. Stable mutation operation keys
  and Action identities make retries restore the same result.
- Action lifecycle data is self-contained and authenticated by runtime-created
  Event Bodies. Public input cannot forge a registered lifecycle receipt.
- Agents and direct LLM calls select ordered `{ connection, model, options }`
  candidates. One process-local `llmConnections` Resource owns each provider's
  transport and static or dynamic authentication. Model choices and reasoning
  options need no registry entries. Authentication resolves once per connection
  per call; secrets never enter the durable call contract. `createLlmAdapter`
  defines a genuinely custom provider implementation.
- The Usage plugin records one durable row for each reported provider attempt
  and provides authorized aggregate analytics and bounded attempt drill-down.
- Tool Resources are data-only presentations of the same Action aliases that
  Core invokes. There is no second Tool execution path.
- Progressive `stream.output` observations contain generic content metadata and
  one subscriber-owned byte follower. Semantic routing stays in plugins.
- Operation replay stores semantic ordering in existing durable Events and
  progressive bytes in their existing Bodies. Its catalog stores only bounded
  discovery, lifecycle, and byte-offset metadata; it is not a second payload
  journal.
- Normal provisioning creates only a fresh v4 schema or validates an existing v4
  schema. Legacy databases require the explicit migration.

## Public package map

| Area               | Subpaths                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Application        | root factory; `/application` types                                                                                                    |
| Generic primitives | `/actions`, `/collections`, `/content`, `/streams`, `/events`, `/plugins`, `/persistence`                                             |
| AI harness         | `/core`, `/llm`, `/llm/tokens`, `/skills`, `/knowledge`, `/memory`, `/goals`, `/usage`, `/usage/client`                               |
| Integrations       | `/channels`, `/schedules`, `/schedules/core`, `/admin`, `/server`                                                                     |
| Host capabilities  | `/adapters/deno`, `/core/cli`, `/core/cli/node`, `/skills/deno`, `/tools/deno`, `/tools/mcp/stdio`, `/tools/persistent-terminal/deno` |
| Tool providers     | `/tools/builtin`, `/tools/finance`, `/tools/mcp`, `/tools/openapi`, `/tools/persistent-terminal`, `/tools/web`                        |

The authoritative export list is `deno.json`. There are no `/domain`,
`/attachments`, generic `/adapters`, `/adapters/node`, or legacy migration
subpaths.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Architecture](docs/architecture.md)
- [API and package reference](docs/api.md)
- [Shared Spaces](docs/spaces.md)
- [Plugins and processors](docs/plugins-and-processors.md)
- [Events, deliveries, and recovery](docs/events-deliveries-recovery.md)
- [Content and assets](docs/content-assets.md)
- [Server façade](docs/server.md)
- [Progressive streams](docs/streams.md)
- [Embedding, Gateway, and Worker roles](docs/embedding-and-hypervisors.md)

The first-principles contract is [ARCHITECTURE.md](ARCHITECTURE.md).

## Verification

```sh
deno task check
deno task test
deno publish --dry-run --allow-dirty
```

## License

MIT
