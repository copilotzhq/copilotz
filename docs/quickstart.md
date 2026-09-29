# Quickstart

Build a room where people and agents talk, then serve it over HTTP and put a
chat UI on it. Each step adds to the previous one.

You need Deno, or Node 24+, and an `OPENAI_API_KEY`.

```sh
deno add jsr:@copilotz/copilotz@^0.82.5
# or
npx jsr add @copilotz/copilotz@^0.82.5 && npm i @electric-sql/pglite && npm pkg set type=module
```

## 1. A room with people and agents

The [README](../README.md#a-room-with-two-people-and-two-agents) example is step
1: two agents, Planner and Critic, and two people, Ana and Ben, in one room.
Three things make it work:

- **Agents are Resources.** Each has an `id`, a `name`, a `role`, the models it
  may use, and its `capabilities`. `capabilities: { agents: ["critic"] }` lets
  Planner ask Critic; that grant is what gives Planner its `ask` tool.
- **A room is a thread with participants.** Channel ingress creates the thread
  and its participants on first use, so the first message needs no setup. Each
  message names its `recipients`: the agents who should answer it.
- **A namespace is the tenant boundary.** `createCopilotz({ namespace })` scopes
  every record, and Copilotz never picks one for you: a send without one fails
  with a message saying so. Any name works for a single-tenant app; a
  multi-tenant app passes each request's tenant.
- **Replies stream.** `send` and `submitChannel` return a turn whose `outputs`
  include each agent's reply as a stream. `coreStreamAgent(output)` says which
  agent is speaking. `done` resolves when the whole turn, including any `ask`,
  has settled.

## 2. Give an agent a tool

A tool is a function the model may call. Define it, install it with a plugin,
and grant it to the agents that may use it:

```ts
import { defineTool } from "@copilotz/copilotz/core";
import { definePlugin } from "@copilotz/copilotz/plugins";

const customers: Record<string, { name: string; plan: string }> = {
  "42": { name: "Grace Hopper", plan: "Enterprise" },
};

const lookupCustomer = defineTool({
  id: "acme.customer.lookup",
  name: "Lookup customer",
  description: "Fetch a customer by ID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute(input: Readonly<{ id: string }>) {
    return customers[input.id] ?? { error: "not found" };
  },
});

const customerPlugin = definePlugin({
  id: "@acme/customers",
  version: "1.0.0",
  resources: { tools: { lookup_customer: lookupCustomer } },
});
```

Add `customerPlugin` to `plugins`, then grant the tool by its alias:

```ts
capabilities: { tools: ["lookup_customer"] },
```

Installing a tool never grants it. An agent uses exactly the tools, teammates
and skills its `capabilities` list; see
[agent capabilities](agent-capabilities.md). Copilotz also ships ready-made
tools: `builtInToolsPlugin` (`/tools/builtin`) for the clock, assets and memory,
and `webToolsPlugin` (`/tools/web`) for web search and fetching pages.

## 3. Serve it over HTTP

Add `coreHttpPlugin` and `serverPlugin`, and describe who may call the API.
`app.fetch` is then a standard Fetch handler for the `/api` routes:

```ts
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
import { defineServerFacade, serverPlugin } from "@copilotz/copilotz/server";

const server = defineServerFacade({
  // Who is calling. Replace this header with your real sign-in.
  authenticate(request) {
    const name = request.headers.get("x-user")?.trim();
    if (!name) return new Response("Sign in first.", { status: 401 });
    return { actor: { id: `person-${name.toLowerCase()}`, name } };
  },
  // What they may do: here, everyone signed in shares every room.
  async authorize(request, { params }) {
    const body = request.method === "POST"
      ? await request.json().catch(() => null)
      : null;
    const threadId = params.id ?? body?.threadId;
    return {
      collections: { thread: {}, message: {}, participant: {} },
      ...(threadId
        ? { actionMetadata: { coreConversationAccess: { threadId } } }
        : {}),
    };
  },
});

const app = await createCopilotz({
  namespace: "demo",
  database: { url: "file://./data" },
  plugins: [corePlugin, coreHttpPlugin, serverPlugin],
  resources: {
    server: { default: server },
    // llmConnections and agents as in step 1
  },
});

Deno.serve({ port: 3000 }, app.fetch);
// Node: import { serve } from "@hono/node-server";
//       serve({ fetch: app.fetch, port: 3000 });
```

`authenticate` names the caller; everything downstream sees only that `actor`.
`authorize` decides what they may read and do. Its `collections` filters apply
to every read, and `coreConversationAccess` lets the caller post in a room they
have not joined yet. When they post, they become a participant. Narrow both to
model private rooms or teams; see [the server guide](server.md).

Any client can now use the API. With the typed client, Ana opens a room and Ben
joins it:

```ts
import { createCopilotzClient } from "@copilotz/copilotz/client";
import { createCoreClient } from "@copilotz/copilotz/core/client";

const person = (name: string) => {
  const client = createCopilotzClient({
    baseUrl: "http://localhost:3000/api",
    getRequestHeaders: () => ({ "x-user": name }),
  });
  return { client, core: createCoreClient(client) };
};
const ana = person("Ana");
const ben = person("Ben");

// Ana opens a room with both agents and asks Planner.
const opened = await ana.core.threads.send({
  externalThreadId: "launch",
  participantIds: ["planner", "critic"],
  recipientIds: ["planner"],
  content: "Planner, how should we launch our library next week?",
}, { idempotencyKey: crypto.randomUUID() });
const { threadId } = await ana.client.operations.result(
  opened.operationId,
) as { threadId: string };

// Ben joins the same room and asks Critic.
await ben.core.threads.send({
  threadId,
  recipientIds: ["critic"],
  content: "Critic, what worries you most?",
}, { idempotencyKey: crypto.randomUUID() });
```

`participantIds` is the room's team of agents; `recipientIds` is who answers
this message. Every write carries an idempotency key, so a retried request
returns the same result instead of posting twice. Read a room with
`core.threads.messages(threadId)`, and follow it live with
`core.threads.observe`.

## 4. Put a chat UI on it

`@copilotz/chat-adapter` renders a multiplayer chat on the same API, with live
updates, streaming replies and an agent picker:

```sh
npm i @copilotz/chat-adapter @copilotz/chat-ui
```

```tsx
import { CopilotzChat } from "@copilotz/chat-adapter";
import "@copilotz/chat-ui/styles.css";

<CopilotzChat
  userId={`person-${name.toLowerCase()}`}
  userName={name}
  baseUrl="/api"
  getRequestHeaders={() => ({ "x-user": name })}
  agentOptions={[
    { id: "planner", name: "Planner" },
    { id: "critic", name: "Critic" },
  ]}
  participantIds={["planner", "critic"]}
  config={{ agentSelector: { enabled: true, mode: "multi" } }}
/>;
```

Pass the same `userId` your server gives the caller as `actor.id`. The chat uses
it to show your messages on the right and everyone else's, people and agents, on
the left with their names.

[Compass Mini](https://github.com/copilotzhq/compass-mini) is this quickstart
carried through: a Node server, a join screen, four agents and room titles, in
about 500 lines.

## 5. Keep your data

Without a `database`, Copilotz keeps everything in memory. Choose where it lives
with a URL:

```ts
database: { url: "file://./data" },        // PGlite on local disk
database: { url: process.env.DATABASE_URL }, // Postgres
```

Every message, model call and tool call is recorded as an event together with
the state it changes. Stop the process and start it again: the room and its
history are still there. Work that was in flight is picked up again, and retries
restore the same result; see
[events, deliveries, and recovery](events-deliveries-recovery.md) for what "at
least once" means for your own code.

## Models and connections

An `llmConnections` entry owns a provider's endpoint and credentials. Agents
choose models from connections, in order: if the first fails, the next is tried.

```ts
llmConnections: {
  openai: { provider: "openai", auth: { apiKey: process.env.OPENAI_API_KEY! } },
},
agents: {
  planner: {
    // ...
    models: {
      generate: [
        {
          connection: "openai",
          model: "your-model",
          options: { reasoningEffort: "high" },
        },
        { connection: "openai", model: "your-fallback-model" },
      ],
    },
  },
},
```

Keys and resolved headers never enter the durable record. For credentials
fetched per call, use `auth: { resolve(context, execution) { ... } }`, which
returns `{ available: true, apiKey, extraHeaders? }` or `{ available: false }`.
`createLlmAdapter({ call })` adds a custom provider. `createChatGptConnection`
from `/llm` connects a ChatGPT account; see
[its contract](../plugins/llm/authoring/chatgpt-connection/README.md).

## Next

- [Agents asking agents](multi-agent-ask.md)
- [Channels](channels.md): WhatsApp, Telegram, Discord, Zendesk and web.
- [Plugins and processors](plugins-and-processors.md): add your own behavior.
- [Architecture](architecture.md)
