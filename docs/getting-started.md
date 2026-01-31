# Getting Started

Get Copilotz running in under 5 minutes. By the end of this guide, you'll have an AI agent that remembers conversations and streams responses.

## Installation

Add Copilotz to your Deno project:

```bash
deno add jsr:@copilotz/copilotz
```

Or add it to your `deno.json` manually:

```json
{
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz"
  }
}
```

### Requirements

- **Deno 2.0+**
- **LLM API key** — OpenAI, Anthropic, Gemini, Groq, DeepSeek, or local Ollama
- **PostgreSQL 13+** (for production) or use PGLite (built-in, for development)

## Try It Instantly with `start()`

The fastest way to try Copilotz is the interactive REPL. Create `chat.ts`:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a helpful assistant. Remember what users tell you.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  }],
  dbConfig: { url: ":memory:" },
});

// Start an interactive session
copilotz.start({
  banner: "🤖 Welcome! Type 'quit' to exit.\n",
  quitCommand: "quit",
  sender: { type: "user", name: "You" },
});
```

Run it:

```bash
OPENAI_API_KEY=your-key deno run --allow-net --allow-env chat.ts
```

You'll get an interactive prompt where you can chat with your agent. Responses stream in real-time, and the agent remembers the conversation.

### `start()` Options

```typescript
copilotz.start({
  // Optional banner message
  banner: "Welcome to my AI assistant!",
  
  // Command to exit (default: "quit")
  quitCommand: "exit",
  
  // Thread identifier for persistence
  threadExternalId: "session-123",
  
  // Sender info
  sender: { type: "user", name: "Alex" },
  
  // Initial message to send
  content: "Hello!",
});
```

Or just pass a string as the initial message:

```typescript
copilotz.start("Hello, introduce yourself!");
```

### Controlling the Session

```typescript
const session = copilotz.start();

// Stop the session programmatically
session.stop();

// Wait for the session to end
await session.closed;
```

---

## Your First Agent (Programmatic)

Create a file called `main.ts`:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

// Create a Copilotz instance with one agent
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a friendly and helpful assistant. Remember details users share with you.",
    llmOptions: { 
      provider: "openai", 
      model: "gpt-4o-mini" 
    },
  }],
  dbConfig: { url: ":memory:" }, // In-memory database for quick start
});

// Send a message
const result = await copilotz.run({
  content: "Hi! My name is Alex and I'm building an AI startup.",
  sender: { type: "user", name: "Alex" },
});

// Wait for completion
await result.done;

// The assistant now remembers Alex
const result2 = await copilotz.run({
  content: "What do you know about me?",
  sender: { type: "user", name: "Alex" },
});

await result2.done;

// Clean up
await copilotz.shutdown();
```

Run it:

```bash
OPENAI_API_KEY=your-key deno run --allow-net --allow-env main.ts
```

## Streaming Responses

For real-time UI updates, enable streaming:

```typescript
const result = await copilotz.run(
  { 
    content: "Tell me a story about a robot", 
    sender: { type: "user", name: "Alex" } 
  },
  // Callback for each event
  (event) => {
    if (event.type === "TOKEN") {
      // Print tokens as they arrive
      Deno.stdout.writeSync(new TextEncoder().encode(event.payload.token));
    }
  },
  { stream: true }
);

await result.done;
console.log("\n--- Done ---");
```

Or use the async iterator:

```typescript
const result = await copilotz.run(
  { content: "Tell me a story", sender: { type: "user", name: "Alex" } },
  undefined,
  { stream: true }
);

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    Deno.stdout.writeSync(new TextEncoder().encode(event.payload.token));
  }
}
```

## Adding Tools

Give your agent the ability to do things:

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a helpful assistant that can read and write files.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["read_file", "write_file", "list_directory"],
  }],
  dbConfig: { url: ":memory:" },
});

// Now your agent can interact with the filesystem
await copilotz.run({
  content: "What files are in the current directory?",
  sender: { type: "user", name: "Alex" },
});
```

## Enabling RAG

Add a knowledge base your agent can search:

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You answer questions based on the knowledge base.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["search_knowledge", "ingest_document"],
    ragOptions: {
      mode: "auto",           // Auto-inject relevant context
      namespaces: ["docs"],   // Search these namespaces
    },
  }],
  rag: {
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    chunking: { strategy: "fixed", chunkSize: 512 },
    defaultNamespace: "docs",
  },
  dbConfig: { url: ":memory:" },
});

// Ingest a document
await copilotz.run({
  content: "Please add this article to your knowledge: https://example.com/article",
  sender: { type: "user", name: "Alex" },
});

// Query the knowledge base
await copilotz.run({
  content: "What did that article say about X?",
  sender: { type: "user", name: "Alex" },
});
```

## Using PostgreSQL

For production, use PostgreSQL instead of in-memory:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  dbConfig: {
    url: "postgres://user:password@localhost:5432/copilotz",
    defaultSchema: "public",
    autoProvisionSchema: true,
  },
});
```

Or use PGLite with file persistence:

```typescript
dbConfig: { url: "file:./data/copilotz.db" }
```

## Environment Variables

Set your LLM API key via environment variable:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...

# Or other providers
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...
export GROQ_API_KEY=gsk_...
export DEEPSEEK_API_KEY=...
```

Copilotz automatically picks up the key based on the provider in `llmOptions`.

## Next Steps

You now have a working AI agent with memory and streaming. Explore further:

- [Overview](./overview.md) — Understand the architecture
- [Agents](./agents.md) — Multi-agent systems and configuration
- [Tools](./tools.md) — All 23 native tools and custom tools
- [RAG](./rag.md) — Document ingestion and semantic search
- [Configuration](./configuration.md) — Full configuration reference
