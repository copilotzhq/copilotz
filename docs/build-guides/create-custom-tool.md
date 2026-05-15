---
title: Create a Custom Tool
description: Define application code that an agent can decide to call.
section: Build Guides
order: 30
status: stable
---

# Create a Custom Tool

A custom tool wraps application code in a model-callable interface.

The agent sees the tool name, description, and input schema. Your code receives
validated-looking arguments and returns the result.

## Example

```ts
import { type Agent, createCopilotz, type Tool } from "@copilotz/copilotz";

const helloTool: Tool = {
  id: "hello-world-tool",
  key: "hello-world-tool",
  name: "Hello World Tool",
  description: "Say hello to a person by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  execute: async (args: { name: string }) => {
    return { message: `Hello, ${args.name}!` };
  },
};

const agent: Agent = {
  id: "assistant",
  name: "Assistant",
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
  tools: [helloTool],
  dbConfig: { url: ":memory:" },
});
```

## Design Advice

Use clear tool names and descriptions. Models choose tools based on the text you
give them.

Keep schemas narrow. If a tool has too many optional paths, the model has more
ways to call it incorrectly.

Return structured data. The runtime can put tool results into history so the
agent can explain them to the user.

## Related Pages

- [Tools, Features, and Processors](../core-concepts/tools-features-processors.md)
- [Tools](../resources/tools.md)
- [Tool Execution Context](../reference/tool-execution-context.md)
