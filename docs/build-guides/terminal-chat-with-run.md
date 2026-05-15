---
title: Build a Terminal Chat with run
description: Recreate copilotz.start manually to understand live conversation mechanics.
section: Build Guides
order: 10
status: stable
---

# Build a Terminal Chat with run

`copilotz.start(...)` is the quick way to chat in a terminal. This guide shows
the underlying `run` loop so the runtime mechanics are visible.

## Complete Example

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
  instructions: "Be helpful, friendly, and concise.",
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
  if (!content) continue;
  if (content === "/exit") break;

  const run = await copilotz.run({
    content,
    target: "assistant",
    sender: { id: "local-user", type: "user", name: "You" },
    thread: { id: "local-thread" },
  });

  for await (const event of run.events) {
    if (event.type !== "NEW_MESSAGE") continue;
    if (event.payload.sender?.type !== "agent") continue;
    console.log(`${event.payload.sender.id}: ${event.payload.content}\n`);
  }

  await run.done;
}

await copilotz.shutdown();
```

## Key Points

Use a stable thread id to preserve history during the process.

Wait for `run.done` before starting the next prompt if you want a simple
turn-by-turn loop.

Filter `NEW_MESSAGE` by `sender.type === "agent"` for clean chat output.

## Related Pages

- [First Principles](../start-here/first-principles.md)
- [Runs](../runtime/runs.md)
- [Run API](../reference/run-api.md)
