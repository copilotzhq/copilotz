---
title: Add a Native Tool
description: Import a bundled Copilotz tool and allow an agent to use it.
section: Build Guides
order: 20
status: stable
---

# Add a Native Tool

Native tools ship with Copilotz, but agents only use the tools you make
available.

This example imports `get_current_time` and allows one agent to call it.

## Configure the Agent

```ts
const agent = {
  id: "assistant",
  name: "Assistant",
  role: "assistant",
  instructions:
    "When the user asks for the time, call get_current_time before answering.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
  allowedTools: ["get_current_time"],
};
```

## Import the Tool

```ts
const copilotz = await createCopilotz({
  agents: [agent],
  resources: {
    imports: ["tools.get_current_time"],
  },
  dbConfig: { url: ":memory:" },
});
```

## Debug Tool Calls

```ts
for await (const event of run.events) {
  if (event.type === "TOOL_CALL") {
    console.log("TOOL CALL:", event.payload);
  }

  if (event.type === "TOOL_RESULT") {
    console.log("TOOL RESULT:", event.payload);
  }
}
```

## What to Expect

The model may first emit an empty or short agent message while choosing a tool,
then a `TOOL_CALL`, then a `TOOL_RESULT`, then a final agent answer.

That is normal event behavior.

## Related Pages

- [Events](../core-concepts/events.md)
- [Tools](../resources/tools.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
