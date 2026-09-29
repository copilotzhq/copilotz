# Copilotz

**Multiplayer AI for your app.** Copilotz is a TypeScript framework for apps
where people and AI agents share the same conversations: several people, several
agents, one room.

Most AI SDKs assume one user talking to one assistant. Put two people and two
agents in a conversation and the hard parts land on you: who is speaking, who is
being addressed, who may see what, when an agent should answer, and how agents
consult each other. In Copilotz that is the native model.

```text
Ana:     Planner, how should we launch our library next week?
Critic:  The weakest point is the missing validation step before launch.
Planner: - Announce on launch day with a short post.
         - Test the quickstart with five outside developers first.
         - Track installs and issues daily for the first week.
Ben:     Critic, what worries you most?
Critic:  That nobody owns each launch task yet.
```

That is example output from the code below: two people and two agents in one
room. Planner asked Critic before answering Ana, in the open, and Ben joined the
same conversation.

## Install

```sh
deno add jsr:@copilotz/copilotz@^0.82.4
# or, with Node 24+
npx jsr add @copilotz/copilotz@^0.82.4 && npm i @electric-sql/pglite
```

## A room with two people and two agents

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { corePlugin, coreStreamAgent } from "@copilotz/copilotz/core";
import { submitChannel, webChannelPlugin } from "@copilotz/copilotz/channels";
import { isStreamOutput } from "@copilotz/copilotz/streams";

const models = { generate: [{ connection: "openai", model: "gpt-5.4-mini" }] };

const app = await createCopilotz({
  namespace: "demo",
  plugins: [corePlugin, webChannelPlugin],
  resources: {
    llmConnections: {
      openai: {
        provider: "openai",
        auth: { apiKey: process.env.OPENAI_API_KEY! },
      },
    },
    agents: {
      planner: {
        id: "planner",
        name: "Planner",
        role:
          "Turn ideas into a plan of three short bullets. Always ask Critic before you answer.",
        models,
        capabilities: { agents: ["critic"] }, // Planner may ask Critic.
      },
      critic: {
        id: "critic",
        name: "Critic",
        role: "Name the weakest point of a plan in one sentence.",
        models,
        capabilities: {},
      },
    },
  },
});

// Two people and two agents share one room.
const room = [
  "planner",
  "critic",
  { externalId: "ana", participantType: "human", name: "Ana" },
  { externalId: "ben", participantType: "human", name: "Ben" },
] as const;

async function say(name: string, text: string, to: string) {
  console.log(`\n${name}: ${text}`);
  const [turn] = await submitChannel(app, "web", [{
    id: crypto.randomUUID(),
    input: {
      externalThreadId: "launch",
      sender: {
        externalId: name.toLowerCase(),
        participantType: "human",
        name,
      },
      recipients: [to],
      content: text,
      thread: { participants: [...room] },
    },
  }]);
  for await (const output of turn.outputs) {
    if (!isStreamOutput(output) || output.role !== "content") continue;
    let reply = "";
    for await (const bytes of output.payload) {
      reply += new TextDecoder().decode(bytes);
    }
    if (reply.trim()) {
      console.log(`\n${coreStreamAgent(output)?.name}: ${reply.trim()}`);
    }
  }
  await turn.done;
}

await say(
  "Ana",
  "Planner, how should we launch our library next week?",
  "planner",
);
await say("Ben", "Critic, what worries you most?", "critic");
await app.close();
```

Run it with `OPENAI_API_KEY` set: `deno run -A room.ts`, or `node room.ts`.
Without a `database`, Copilotz keeps everything in memory; pass
`database: { url: "file://./data" }` for PGlite on disk, or a Postgres URL.

## What you get

- **Rooms with people and agents.** Threads hold any mix of human and agent
  participants. Each message says who sent it and whom it addresses, so an agent
  answers when it is asked, not whenever anyone speaks.
- **Agents that consult each other in the open.** Grant an agent its teammates
  and it gets an `ask` tool. The question and the answer are ordinary messages
  in the room that everyone can read, and the asking agent continues once the
  answer arrives.
- **Nothing is granted by default.** Tools, teammates and skills are exact
  per-agent grants. Installing a plugin never widens what an existing agent may
  do.
- **A backend, not just a loop.** Add `serverPlugin` and `app.fetch` serves an
  HTTP API with authentication and authorization hooks, live observation of each
  room, idempotent writes and OpenAPI. `@copilotz/chat-adapter` renders a
  multiplayer chat UI on top of it.
- **Where people already are.** Web, WhatsApp, Telegram, Discord and Zendesk
  channels, plus MCP, OpenAPI and web tools.
- **It holds up.** Every message, model call and tool call is an immutable
  event, committed together with the state it changes. Restart the process and
  the room is intact; retried work restores the same result.
- **Runs where TypeScript runs.** Deno and Node, with PGlite on local disk or
  Postgres. Provider fallback across models and connections, with credentials
  kept out of the durable record.

## See it in a real app

[Compass Mini](https://github.com/copilotzhq/compass-mini) is a complete
multiplayer workspace in about 500 lines: people join by name, share rooms with
four agents that ask each other for help, and see each other's messages live. It
runs on Node with no database to set up.

## Documentation

**Start**

- [Quickstart](docs/quickstart.md): a room, then an HTTP API, then a chat UI.

**Build**

- [Agent capabilities](docs/agent-capabilities.md): tools, teammates and skills,
  granted per agent.
- [Agents asking agents](docs/multi-agent-ask.md): the public `ask`.
- [HTTP server and browser client](docs/server.md): auth, access and live rooms.
- [Channels](docs/channels.md): web, messaging apps and support desks.
- [Shared Spaces](docs/spaces.md), [memory](docs/memory.md) and
  [skills](docs/skills.md).

**Run in production**

- [Events, deliveries, and recovery](docs/events-deliveries-recovery.md): what
  "at least once" means for your code.
- [Embedding, Gateway, and Worker roles](docs/embedding-and-hypervisors.md): one
  process or many, and sizing the database pool.
- [Host capability adapters](docs/runtime-adapters.md).

**Understand and extend**

- [Architecture](docs/architecture.md) and the first-principles contract in
  [ARCHITECTURE.md](ARCHITECTURE.md).
- [Plugins and processors](docs/plugins-and-processors.md): add your own
  behavior.
- [Content and assets](docs/content-assets.md) and
  [progressive streams](docs/streams.md).
- [API and package reference](docs/api.md).

## How it is built

The runtime owns generic mechanics; plugins own meaning. Plugins contribute five
primitives: Collections (durable state), Actions (capabilities with one durable
lifecycle), Processors (reactions to events), Resources (agents, models, tools
and policy) and Adapters (external implementations). Messages, agents, tools and
channels are plugins built from these primitives; the agent loop is Processors
reacting to events, not a hidden controller. See
[Architecture](docs/architecture.md).

| Area               | Subpaths                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Application        | root factory; `/application` types                                                                                                    |
| Generic primitives | `/actions`, `/collections`, `/content`, `/streams`, `/events`, `/plugins`, `/persistence`                                             |
| AI harness         | `/core`, `/llm`, `/llm/tokens`, `/skills`, `/knowledge`, `/memory`, `/goals`, `/usage`, `/usage/client`                               |
| Integrations       | `/channels`, `/schedules`, `/schedules/core`, `/admin`, `/server`                                                                     |
| Host capabilities  | `/adapters/deno`, `/core/cli`, `/core/cli/node`, `/skills/deno`, `/tools/deno`, `/tools/mcp/stdio`, `/tools/persistent-terminal/deno` |
| Tool providers     | `/tools/builtin`, `/tools/finance`, `/tools/mcp`, `/tools/openapi`, `/tools/persistent-terminal`, `/tools/web`                        |

Importing the root does not pull in filesystem, subprocess, terminal, MCP stdio,
or provider credentials; host-only capabilities live on explicit subpaths. The
authoritative export list is `deno.json`.

## Contributing

```sh
deno task check
deno task test
deno publish --dry-run --allow-dirty
```

## License

MIT
