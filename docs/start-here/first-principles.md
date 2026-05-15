---
title: First Principles
description: Rebuild copilotz.start with copilotz.run, then add threads, events, and tools.
section: Start Here
order: 30
status: stable
---

# First Principles

The fastest way to understand Copilotz is to rebuild `copilotz.start(...)` by
hand.

`start` is a convenience for a terminal conversation. Under the hood, the core
primitive is `run`.

## The Core Loop

A live chat is a loop:

1. ask the user for input
2. send that input to `copilotz.run(...)`
3. listen to the run events
4. print the agent messages
5. repeat until the user exits

```ts
import {
  type Agent,
  type CopilotzConfig,
  createCopilotz,
} from "@copilotz/copilotz";

const agent: Agent = {
  id: "test-agent",
  name: "Test Agent",
  role: "assistant",
  instructions:
    "You are a customer support agent. Be friendly, helpful, and concise.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
};

const config: CopilotzConfig = {
  agents: [agent],
  dbConfig: { url: ":memory:" },
};

const copilotz = await createCopilotz(config);

while (true) {
  const content = prompt("You > ");
  console.log("");

  if (!content) continue;
  if (content === "/exit") break;

  const run = await copilotz.run({
    content,
    target: "test-agent",
    sender: { id: "test-sender", type: "user", name: "You" },
    thread: { id: "thread-1" },
  });

  for await (const event of run.events) {
    if (
      event.type === "NEW_MESSAGE" &&
      event.payload.sender?.type === "agent"
    ) {
      console.log(`${event.payload.sender.id}: ${event.payload.content}`);
      console.log("");
    }
  }

  await run.done;
}

await copilotz.shutdown();
```

That is the basic shape of `start`.

## Why the Thread Matters

The `thread` property identifies the conversation.

If you do not pass a thread, Copilotz assumes this is a new conversation. That
means the agent receives no previous history for that run.

If you pass `thread.id` or `thread.externalId`, Copilotz can load the previous
messages for the same conversation.

```ts
await copilotz.run({
  content: "Remember that my company is ACME.",
  target: "test-agent",
  sender: { id: "test-sender", type: "user" },
  thread: { id: "thread-1" },
});

await copilotz.run({
  content: "What is my company?",
  target: "test-agent",
  sender: { id: "test-sender", type: "user" },
  thread: { id: "thread-1" },
});
```

Same thread, same conversation history.

## In-Memory vs Persistent Databases

With `dbConfig: { url: ":memory:" }`, history exists only while that Copilotz
instance is alive.

If you keep the process running and keep using the same thread id, the agent can
use the in-memory history. When you call `shutdown()` and exit the process, that
memory is gone.

With PostgreSQL or file-backed PGlite, the conversation can survive process
restarts because the thread, messages, events, and related data are persisted.

```ts
const copilotz = await createCopilotz({
  agents: [agent],
  dbConfig: {
    url: "postgresql://postgres:password@localhost:5432/postgres",
  },
});
```

## Events Are the Runtime Surface

`run.events` is the live stream of what the runtime produced.

The most common event is `NEW_MESSAGE`. User messages, agent messages, and
tool-history messages can all appear as `NEW_MESSAGE`, so filter by sender type
when printing a clean chat.

```ts
for await (const event of run.events) {
  if (event.type !== "NEW_MESSAGE") continue;
  if (event.payload.sender?.type !== "agent") continue;

  console.log(`${event.payload.sender.id}: ${event.payload.content}`);
}
```

For debugging, also print tool events:

```ts
for await (const event of run.events) {
  if (event.type === "NEW_MESSAGE" && event.payload.sender?.type === "agent") {
    console.log(`${event.payload.sender.id}: ${event.payload.content}`);
  }

  if (event.type === "TOOL_CALL") {
    console.log("TOOL CALL:", JSON.stringify(event.payload));
  }

  if (event.type === "TOOL_RESULT") {
    console.log("TOOL RESULT:", JSON.stringify(event.payload));
  }
}
```

This explains a common surprise: when an agent calls a tool, you may see an
empty agent message and then a JSON-looking message from a tool sender. That is
expected. Tool output is inserted into conversation history so the model can use
it, but you usually do not print it as user-facing chat.

## Add a Native Tool

Without tools, an agent can only talk. With tools, an agent can act.

Copilotz ships native tools. To use one, import it into the runtime and allow
the agent to call it.

```ts
const agent: Agent = {
  id: "test-agent",
  name: "Test Agent",
  role: "assistant",
  instructions:
    "No matter what the user asks, use the current time tool and answer with the current time.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
  allowedTools: ["get_current_time"],
};

const copilotz = await createCopilotz({
  agents: [agent],
  resources: {
    imports: ["tools.get_current_time"],
  },
  dbConfig: { url: ":memory:" },
});
```

Now the agent can call `get_current_time` when it needs the current time.

AI behavior is probabilistic, so if you need stricter behavior, make the
instructions explicit and narrow. For example: "Do not answer any other request.
Always call the current time tool before answering."

## Create a Custom Tool

Custom tools are normal TypeScript functions wrapped in a tool definition.

```ts
import { type Agent, createCopilotz, type Tool } from "@copilotz/copilotz";

const tool: Tool = {
  id: "hello-world-tool",
  key: "hello-world-tool",
  name: "Hello World Tool",
  description: "Say hello to a person.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  execute: async (args: { name: string }) => {
    console.log(`Hello, ${args.name}!`);
    return { ok: true, message: `Hello, ${args.name}!` };
  },
};

const agent: Agent = {
  id: "test-agent",
  name: "Test Agent",
  role: "assistant",
  instructions: "Use hello-world-tool to greet the user.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
  allowedTools: ["hello-world-tool"],
};

const copilotz = await createCopilotz({
  agents: [agent],
  tools: [tool],
  dbConfig: { url: ":memory:" },
});
```

The tool is agent-owned behavior: the model decides when to call it based on the
conversation, instructions, tool name, description, and schema.

## APIs Can Become Tools

Copilotz also supports API resources. An API resource describes an external API,
and Copilotz can expose operations from that API to agents as tools.

Use custom tools when the behavior is code you own.

Use API resources when the behavior is an external HTTP API and you want the
framework to shape it into callable tools.

## What to Learn Next

- [Choose the Right Primitive](./choose-the-right-primitive.md)
- [Threads and Messages](../core-concepts/threads-and-messages.md)
- [Events](../core-concepts/events.md)
- [Add a Native Tool](../build-guides/add-native-tool.md)
- [Create a Custom Tool](../build-guides/create-custom-tool.md)
