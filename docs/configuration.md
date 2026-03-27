# Configuration

This document covers all configuration options for `createCopilotz` and `run`.

## CopilotzConfig

The main configuration object passed to `createCopilotz`:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  // Required
  agents: [...],
  
  // Database
  dbConfig: { ... },
  dbInstance: existingDb,
  
  // Tools & Integrations
  tools: [...],
  apis: [...],
  mcpServers: [...],
  
  // Processing
  processors: [...],
  callbacks: { ... },
  historyTransform: async ({ messages, rawHistory }) => messages,
  
  // RAG
  rag: { ... },
  
  // Collections
  collections: [...],
  collectionsConfig: { ... },
  
  // Assets
  assets: { ... },
  
  // Runtime defaults
  stream: false,
  queueTTL: 3600000,
  namespace: "default",
  threadMetadata: { ... },
  activeTaskId: "task-id",
});
```

## Agents

```typescript
agents: [{
  id: "assistant",              // Unique identifier (required)
  name: "Assistant",            // Display name (required)
  role: "assistant",            // "assistant", "system", or "user" (required)
  instructions: "Be helpful.",  // System prompt
  llmOptions: {                 // LLM configuration (required)
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    apiKey: "sk-...",           // Override env variable
    baseUrl: "...",             // Custom endpoint
    outputReasoning: false,     // Default true; whether to emit reasoning tokens ("thinking") during stream
  },
  allowedTools: ["*"],          // Tool whitelist
  allowedAgents: ["other"],     // Agent communication whitelist
  ragOptions: {                 // Per-agent RAG settings
    mode: "auto",
    namespaces: ["docs"],
    autoInjectLimit: 4,
    entityExtraction: { enabled: true },
  },
}]
```

## Database

```typescript
dbConfig: {
  url: "postgres://user:pass@localhost:5432/db",  // Connection URL
  // OR for PGLite:
  // url: ":memory:"           // In-memory
  // url: "file:./data/db"     // File-based
  
  defaultSchema: "public",      // Default PostgreSQL schema
  autoProvisionSchema: true,    // Auto-create schemas
  syncUrl: "postgres://...",    // Replication URL
  pgliteExtensions: [           // PGLite extensions
    "uuid_ossp",
    "pg_trgm",
    "vector",
  ],
  schemaSQL: "CREATE TABLE ...",  // Extra init SQL
  useWorker: false,             // PGLite worker mode
  logMetrics: false,            // Performance logging
  
  // Crash recovery configuration
  staleProcessingThresholdMs: 300000,  // 5 minutes (default)
}

// OR reuse existing database
dbInstance: existingDatabase
```

### Crash Recovery

The `staleProcessingThresholdMs` option provides automatic recovery from server crashes:

```typescript
dbConfig: {
  url: "postgres://...",
  staleProcessingThresholdMs: 120000,  // 2 minutes
}

// OR at top level
const copilotz = await createCopilotz({
  agents: [...],
  staleProcessingThresholdMs: 120000,  // 2 minutes
  dbConfig: { url: "postgres://..." },
});
```

**How it works:**
- Events stuck in `"processing"` status longer than the threshold are automatically reset to `"pending"`
- This prevents permanent deadlocks when the server crashes mid-processing
- Default: 5 minutes (300000ms)
- Set lower for faster recovery, higher for long-running operations

**When to adjust:**
- **Lower (1-2 min)**: Fast recovery, but may reset legitimately slow operations
- **Higher (10-15 min)**: For operations that genuinely take a long time
- **Default (5 min)**: Good balance for most use cases

## Custom Tools

```typescript
tools: [{
  id: "weather",
  name: "Get Weather",
  description: "Get current weather for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  },
  outputSchema: {
    type: "object",
    properties: {
      temperature: { type: "number" },
      conditions: { type: "string" },
    },
  },
  execute: async (input, context) => {
    const { city } = input;
    const { threadId, namespace, db } = context;
    // Your implementation
    return { temperature: 72, conditions: "sunny" };
  },
  historyPolicy: {
    visibility: "public_result",
    projector: ({ city }, output) => {
      const weather = output as { temperature: number; conditions: string };
      return `Weather loaded for ${city}: ${weather.temperature}°, ${weather.conditions}`;
    },
  },
}]
```

`historyPolicy.visibility` supports:

- `requester_only`
- `public_result`
- `public_full`

Use `projector` with `public_result` when other agents should see a compact business-level outcome instead of the raw tool payload.

## OpenAPI Integrations

```typescript
apis: [{
  id: "github",
  name: "GitHub API",
  openApiSchema: myOpenApiSchema,      // Object or JSON/YAML string (NOT a file path)
  baseUrl: "https://api.github.com",   // Override spec base URL
  auth: {
    type: "bearer",
    token: process.env.GITHUB_TOKEN,
  },
  historyPolicyDefaults: {
    visibility: "requester_only",
  },
  toolPolicies: {
    getRepository: {
      visibility: "public_result",
      projector: (_args, output) => {
        const repo = output as { full_name?: string };
        return `Repository loaded: ${repo.full_name}`;
      },
    },
  },
  // OR other auth types:
  // auth: { type: "apiKey", key: "X-API-Key", value: "...", in: "header" }
  // auth: { type: "basic", username: "...", password: "..." }
  // auth: { type: "dynamic", authEndpoint: "...", tokenPath: "..." }
}]
```

> **Note:** To load OpenAPI specs from files, use [`loadResources()`](./loaders.md) or import the file yourself.
>
> `toolPolicies` are keyed by the generated tool key, usually the OpenAPI `operationId`.

## MCP Servers

```typescript
mcpServers: [{
  id: "filesystem",
  name: "File System",
  transport: {
    type: "stdio",
    command: "node",
    args: ["./mcp-server.js"],
    env: { ... },
  },
  historyPolicyDefaults: {
    visibility: "requester_only",
  },
  toolPolicies: {
    read_file: {
      visibility: "requester_only",
    },
    list_directory: {
      visibility: "public_result",
      projector: (_args, output) => {
        const result = output as { entries?: unknown[] };
        return `Directory listed successfully (${result.entries?.length ?? 0} entries).`;
      },
    },
  },
}]
```

For MCP servers, overrides can be keyed by either the generated Copilotz tool key (`serverName_toolName`) or the original MCP tool name.

## Custom Processors

```typescript
processors: [{
  eventType: "NEW_MESSAGE",
  shouldProcess: (event, deps) => {
    return event.payload.metadata?.custom === true;
  },
  process: async (event, deps) => {
    // Custom logic
    return {
      producedEvents: [
        { type: "CUSTOM_EVENT", payload: { ... } }
      ],
    };
  },
}]
```

## Callbacks

```typescript
callbacks: {
  // Called for every event
  onEvent: async (event) => {
    console.log(`Event: ${event.type}`);
    // Can return { producedEvents: [...] } to inject events
  },
  
  // Called for streaming tokens
  onContentStream: async (data) => {
    // data: { threadId, agentName, token, isComplete }
    process.stdout.write(data.token);
  },
  
  // Called after processing to push to client
  onStreamPush: async (event) => {
    // Push event to client stream
  },
}
```

## History Transform

Use `historyTransform` to filter or rewrite the generated message history before it is sent to the LLM.

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  historyTransform: async ({ messages, rawHistory, thread, agent, sourceEvent, deps }) => {
    // Example: keep only the last 2 hours of history
    const cutoff = Date.now() - (2 * 60 * 60 * 1000);

    return messages.filter((_message, index) => {
      const createdAt = rawHistory[index]?.createdAt;
      const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN;
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    });
  },
});
```

### History Transform Semantics

- Runs after Copilotz generates chat history and before the system prompt is added
- Receives both normalized `messages` and aligned `rawHistory`
- Must return the final `ChatMessage[]` to send as history
- May be async
- Does not receive or modify the agent system prompt

Use this hook for redaction, age-based filtering, attachment stripping, or tenant-specific history rules. If you need to change instructions, do that in the agent configuration instead.

## RAG Configuration

```typescript
rag: {
  enabled: true,  // Default: true if config provided
  
  embedding: {
    provider: "openai",                 // "openai", "ollama", "cohere"
    model: "text-embedding-3-small",
    apiKey: "...",                      // Override env
    baseUrl: "...",                     // Custom endpoint
    dimensions: 1536,                   // Embedding dimensions
    batchSize: 100,                     // Batch size for embedding
  },
  
  chunking: {
    strategy: "fixed",                  // "fixed", "paragraph", "sentence"
    chunkSize: 512,                     // Target tokens per chunk
    chunkOverlap: 50,                   // Overlap between chunks
  },
  
  retrieval: {
    defaultLimit: 5,                    // Default results to retrieve
    similarityThreshold: 0.7,           // Minimum similarity (0-1)
  },
  
  defaultNamespace: "docs",             // Default namespace for storage
  
  namespaceResolver: async (context) => {
    // Dynamic namespace resolution
    return `customer:${context.message.metadata?.customerId}`;
  },
}
```

## Collections Configuration

```typescript
collections: [customer, ticket, ...],  // Collection definitions

collectionsConfig: {
  autoIndex: true,          // Create indexes on startup
  validateOnWrite: true,    // Validate against schema on write
}
```

## Assets Configuration

```typescript
assets: {
  config: {
    backend: "fs",          // "fs" or "s3"
    
    // Filesystem backend
    fs: {
      rootDir: "./data/assets",
    },
    
    // S3 backend
    s3: {
      bucket: "my-bucket",
      endpoint: "...",      // Custom S3 endpoint
      region: "us-east-1",
      accessKeyId: "...",
      secretAccessKey: "...",
      // connector: createS3Connector({ ... }) // optional
    },
    
    // Optional asset namespacing (tenant isolation)
    namespacing: {
      mode: "context",      // "none" or "context"
      includeInRef: true,   // asset://<namespace>/<id>
    },
    
    inlineThresholdBytes: 100_000,  // Max size for inline assets
    resolveInLLM: true,             // Resolve asset refs for LLM
  },
  
  // OR provide existing store
  store: existingAssetStore,
}
```

## Multi-Agent Configuration

```typescript
multiAgent: {
  enabled: true,              // Required to allow agent-to-agent delegation
  maxAgentTurns: 5,           // Max consecutive agent-to-agent turns before forcing user target
  includeTargetContext: true, // Include "(addressed to: X)" in history for multi-agent awareness
}
```

### Loop Prevention

The `maxAgentTurns` setting prevents infinite agent-to-agent conversations:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  multiAgent: {
    enabled: true,
    maxAgentTurns: 3,  // After 3 agent turns, force target back to user
  },
});
```

**How it works:**
- Each consecutive agent turn increments a counter in thread metadata
- When the counter reaches `maxAgentTurns`, the next message targets the original human user
- Human messages reset the counter to 0

### Target Context in History

When `includeTargetContext` is true (default), chat history includes addressing info:

```
[User]: @Researcher, what's the data on climate change?
[Researcher]: (addressed to: User) Here's what I found...
[User]: @Writer, can you summarize that?
[Writer]: (addressed to: User) Here's a summary...
```

This helps agents understand conversation flow and who is speaking to whom.

## Runtime Defaults

```typescript
stream: false,                        // Enable streaming by default
queueTTL: 3600000,                   // Queue item TTL (1 hour)
staleProcessingThresholdMs: 300000,  // Crash recovery threshold (5 minutes)
namespace: "default",                 // Default namespace
threadMetadata: {                     // Metadata for new threads
  source: "api",
  version: "1.0",
},
activeTaskId: "task-123",             // Default task context
```

---

## RunOptions

Options passed to `copilotz.run()`:

```typescript
await copilotz.run(message, onEvent, {
  stream: true,                    // Enable streaming for this run
  ackMode: "immediate",            // "immediate" or "onComplete"
  signal: abortController.signal,  // AbortSignal for cancellation
  queueTTL: 60000,                 // TTL for this run's events
  namespace: "workspace:123",      // Override default namespace
  schema: "tenant_acme",           // Override default schema
  
  // Override agents for this run
  agents: [{
    id: "assistant",
    instructions: "Be extra helpful today!",
  }],
  
  // Override tools for this run
  tools: [{
    id: "special_tool",
    execute: async (input) => { ... },
  }],
});
```

### Programmatic Routing

Use `target` and `targetQueue` to route messages programmatically without relying on @mentions:

```typescript
// Route directly to a specific agent
await copilotz.run(
  {
    content: "Process this data",
    sender: { type: "user", name: "Alex" },
    target: "data-processor",
  },
  onEvent
);

// Route to multiple agents in sequence
await copilotz.run(
  {
    content: "Review and approve",
    sender: { type: "user", name: "Alex" },
    targetQueue: ["reviewer", "approver"],
  },
  onEvent
);
```

When `targetQueue` is provided without `target`, the first item in the queue becomes the primary target and the remaining items stay queued.

---

## Environment Variables

LLM provider keys can be set via environment variables:

| Provider | Environment Variable |
|----------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Ollama | `OLLAMA_API_KEY` (or use `baseUrl`) |

The library checks `${PROVIDER}_API_KEY` first, then falls back to `OPENAI_API_KEY`.

---

## Complete Example

```typescript
import { createCopilotz, defineCollection, index, relation } from "@copilotz/copilotz";

// Define collections
const customer = defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
    },
    required: ["id", "email"],
  } as const,
  indexes: [index.field("email")],
});

// Create Copilotz
const copilotz = await createCopilotz({
  agents: [{
    id: "support",
    name: "Support Agent",
    role: "assistant",
    instructions: "You are a helpful support agent.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["search_knowledge", "http_request"],
    ragOptions: { mode: "auto", namespaces: ["docs", "faq"] },
  }],
  
  dbConfig: {
    url: process.env.DATABASE_URL || ":memory:",
    autoProvisionSchema: true,
  },
  
  rag: {
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    chunking: { strategy: "fixed", chunkSize: 512 },
    retrieval: { defaultLimit: 5, similarityThreshold: 0.7 },
  },
  
  collections: [customer],
  collectionsConfig: { autoIndex: true },
  
  callbacks: {
    onEvent: async (event) => {
      console.log(`[${event.type}]`, event.payload);
    },
  },
  
  stream: true,
  namespace: "default",
});

// Run with streaming
const result = await copilotz.run(
  { content: "Hello!", sender: { type: "user", name: "Alex" } },
  (event) => {
    if (event.type === "TOKEN") {
      process.stdout.write(event.payload.token);
    }
  },
  { namespace: "workspace:123" }
);

await result.done;
await copilotz.shutdown();
```

## Next Steps

- [Getting Started](./getting-started.md) — Quick start guide
- [Agents](./agents.md) — Agent configuration details
- [API Reference](./api-reference.md) — Full API documentation
