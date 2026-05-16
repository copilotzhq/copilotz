# Chapter 2: Your First Tool

> **Part 1 — Foundations**

## The pain

Ask your agent "what time is it?" and it'll tell you — incorrectly. LLMs are trained on static snapshots of the world. They hallucinate current time, live prices, real-time system data, and anything that changes between training runs.

More fundamentally: your agent can only *respond* to questions. It can't *do* anything. It can't query your database, call an API, write a file, or run any code. It's a very sophisticated autocomplete.

That's not an AI agent. That's a chatbot.

## The solution

Tools let the LLM call your code. You define a tool with a name, a description, and an input schema. When the LLM decides a tool is relevant, it constructs the arguments and Copilotz executes your function. The result goes back into the conversation.

Add a `getTime` tool to your agent:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const getTimeTool = {
  key: "get_time",
  name: "Get Current Time",
  description: "Returns the current date and time in ISO format. Use this when the user asks what time it is.",
  // No inputSchema needed — this tool takes no arguments
  execute: async () => {
    return { time: new Date().toISOString() };
  },
};

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A helpful assistant that can check the current time.",
      instructions: "When the user asks about time or date, always use the get_time tool.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
      },
      allowedTools: ["get_time"], // Whitelist which tools this agent can use
    },
  ],
  tools: [getTimeTool],
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Ask me what time it is.\n" });
```

Run it and ask "what time is it?" — the agent will call `get_time`, get the real timestamp, and respond accurately.

## Anatomy of a tool

```typescript
const myTool = {
  key: "my_tool",          // Identifier used in allowedTools and history
  name: "My Tool",         // Human-readable name shown in history
  description: "...",      // Critical: the LLM reads this to decide when to use the tool
  inputSchema: {           // JSON Schema for the tool's arguments
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      limit: { type: "number", description: "Maximum results to return", default: 10 },
    },
    required: ["query"],
  },
  execute: async (args, context) => {
    // args is typed based on your inputSchema
    // context.onCancel lets you register cleanup for graceful shutdown
    // context.cancelled is true if the run was aborted
    return { results: [] };
  },
};
```

The `description` field is the most important one. The LLM reads it to decide when the tool applies. Be specific about *when* to use it and *what* it returns.

## A more realistic example

Here's a tool that fetches weather data:

```typescript
const getWeatherTool = {
  key: "get_weather",
  name: "Get Weather",
  description: "Fetches current weather conditions for a given city. Use when the user asks about weather, temperature, or conditions in a specific location.",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "The city name to get weather for, e.g. 'New York' or 'Tokyo'",
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature units",
        default: "celsius",
      },
    },
    required: ["city"],
  },
  execute: async ({ city, units = "celsius" }) => {
    const unit = units === "celsius" ? "metric" : "imperial";
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=${unit}&appid=${Deno.env.get("OPENWEATHER_API_KEY")}`
    );
    const data = await response.json();
    return {
      city: data.name,
      temperature: data.main.temp,
      feels_like: data.main.feels_like,
      description: data.weather[0].description,
      humidity: data.main.humidity,
    };
  },
};
```

## Controlling which tools an agent can use

`allowedTools` is a whitelist. If it's `undefined`, the agent has access to all registered tools. Use it to scope agent capabilities:

```typescript
{
  id: "customer-service",
  allowedTools: ["lookup_order", "update_ticket", "send_email"],
  // This agent cannot call any other tool, even if registered globally
}
```

## Handling tool results in the conversation

After `execute` returns, the result is serialized and injected into the conversation history as a tool message. The LLM reads it and responds to the user. You don't need to manage this manually.

You can control how tool results appear in history with `historyPolicy`:

```typescript
{
  key: "my_tool",
  historyPolicy: {
    visibility: "public_result",   // "requester_only" | "public_status" | "public_result" | "public_full"
  },
  execute: async (args) => { ... },
}
```

`requester_only` hides the result from other agents in multi-agent scenarios. `public_result` shows the result to all agents. Useful when you have orchestrator/worker patterns.

## What this unlocks

- The LLM can now call arbitrary functions — your code, your database, any API
- Tool selection is handled by the LLM; you just define what's available
- Results are automatically woven back into the conversation
- Graceful cancellation via the `context.cancelled` flag

## What's next

Writing a custom tool for every common operation — HTTP requests, file reads, shell commands — is tedious. Copilotz ships 27 production-ready tools out of the box. In the next chapter, you'll use them.

→ **[Chapter 3: Native Tools](../part-2-tools/03-native-tools.md)**
