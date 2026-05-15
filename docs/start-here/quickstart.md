---
title: Quickstart
description: Create a minimal Copilotz instance and run your first agent message.
section: Start Here
order: 20
status: stable
---

# Quickstart

This guide creates one agent, sends one message, and prints the agent response.

## Install

```bash
deno add jsr:@copilotz/copilotz
```

## Create an Agent

```ts
import {
  type Agent,
  type CopilotzConfig,
  createCopilotz,
} from "@copilotz/copilotz";

const agent: Agent = {
  id: "assistant",
  name: "Assistant",
  role: "assistant",
  instructions: "You are friendly, helpful, and concise.",
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
```

## Run a Message

```ts
const run = await copilotz.run({
  content: "Hello. What can you help me with?",
  sender: { id: "user-1", type: "user", name: "User" },
  target: "assistant",
});

for await (const event of run.events) {
  if (
    event.type === "NEW_MESSAGE" &&
    event.payload.sender?.type === "agent"
  ) {
    console.log(event.payload.content);
  }
}

await run.done;
await copilotz.shutdown();
```

## Run It

```bash
OPENAI_API_KEY=... deno run -A --env main.ts
```

## What Happened

`createCopilotz(...)` created the runtime.

`copilotz.run(...)` created a `NEW_MESSAGE` event from the user. The event
runtime routed that message to the target agent, called the LLM, persisted the
conversation, and streamed events back through `run.events`.

`run.done` resolved after the queue work finished.

## Next

Read [First Principles](./first-principles.md) to learn how this becomes a live
conversation loop and how tools fit into the same event stream.
