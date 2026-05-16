---
title: "Ch 1: Hello Agent"
description: "Get a conversational agent running in minutes with a streaming REPL."
section: Getting Started
order: 10
status: stable
---

# Chapter 1: Hello Agent

> **Part 1 — Foundations**

## The pain

You've decided to build an AI-powered feature. So you open the OpenAI docs, grab a chat completions client, and start writing. Within an hour you've wired together a prompt, a history array, a streaming loop, and a while loop that reads from stdin. It works — sort of. Then you need conversation persistence. Then token streaming to a frontend. Then multi-turn memory. Each one is a small project in itself.

You wanted to build a product, not a platform.

## The solution

`createCopilotz()` is a single function call that gives you a complete, production-capable agent runtime. You bring the model credentials and a description of what you want the agent to do. Copilotz handles the rest.

Create a file `main.ts`:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A helpful, concise AI assistant.",
      instructions: "Answer questions clearly and briefly. If you don't know something, say so.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
      },
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async ({ provider }) => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Assistant ready. Type your message.\n" });
```

Run it:

```sh
OPENAI_API_KEY=<your-key> deno run -A --env main.ts
```

That's a fully functional conversational agent. Persistent threads, streaming output, multi-turn memory — all included.

## Breaking it down

### `agents`

The `agents` array defines who your agents are and how they behave.

```typescript
{
  id: "assistant",       // Unique identifier — used for routing and tool allowlists
  name: "Assistant",     // Display name shown in history
  role: "...",           // Short description of purpose (always injected into system prompt)
  instructions: "...",   // Detailed behavioral instructions
  llmOptions: {
    provider: "openai",  // Which LLM provider to use
    model: "gpt-4o-mini",
  },
}
```

`role` is always present in the system prompt. `instructions` is the full behavioral guide.

### `security.resolveLLMRuntimeConfig`

This hook runs before every LLM call to inject credentials at runtime — they're never stored in the database. It receives the provider name and returns the config to merge in:

```typescript
resolveLLMRuntimeConfig: async ({ provider, agent }) => {
  return { apiKey: Deno.env.get(`${provider.toUpperCase()}_API_KEY`) };
}
```

You can vary credentials by provider, by agent, or by any runtime condition.

### `dbConfig`

Copilotz uses a database to persist conversations, events, and memory. In development, `:memory:` gives you an in-process PGlite database — no setup required.

For production, swap this for a real PostgreSQL connection string:

```typescript
dbConfig: { url: "postgresql://user:pass@localhost/myapp" }
```

### `copilotz.start()`

`start()` launches an interactive CLI loop: it reads from stdin, runs each message through the agent, and streams the response to stdout. Perfect for development.

For programmatic use (HTTP handlers, tests, background jobs), use `copilotz.run()` instead:

```typescript
const result = await copilotz.run({
  content: "What is the capital of France?",
  sender: { type: "user", name: "Alice" },
});

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    await Deno.stdout.write(new TextEncoder().encode(event.payload.token ?? ""));
  }
}

await result.done;
```

`run()` returns a handle with:
- `events` — async iterable of streaming events (tokens, tool calls, etc.)
- `done` — promise that resolves when processing is complete
- `cancel()` — gracefully aborts the run

## Switching providers

The `provider` field accepts any built-in provider. Swap the model without changing anything else:

```typescript
// Anthropic
llmOptions: { provider: "anthropic", model: "claude-opus-4-5" }

// Google Gemini
llmOptions: { provider: "gemini", model: "gemini-2.0-flash" }

// Groq (fast inference)
llmOptions: { provider: "groq", model: "llama-3.1-70b-versatile" }

// Local via Ollama
llmOptions: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" }
```

The `security.resolveLLMRuntimeConfig` hook handles credentials for each provider.

## What this unlocks

- A persistent conversational agent in under 20 lines
- Streaming token output, built in
- Multi-turn conversation history, maintained automatically
- Provider-agnostic — swap models with one line change

## What's next

Your agent can talk, but it only knows what its training data includes. Ask it "what time is it?" and it guesses. Real agents don't just respond — they act. In the next chapter, you'll give your agent the ability to call arbitrary code.

→ **[Chapter 2: Your First Tool](./02-your-first-tool.md)**
