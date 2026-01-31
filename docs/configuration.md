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
}

// OR reuse existing database
dbInstance: existingDatabase
```

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
}]
```

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
  // OR other auth types:
  // auth: { type: "apiKey", key: "X-API-Key", value: "...", in: "header" }
  // auth: { type: "basic", username: "...", password: "..." }
  // auth: { type: "dynamic", authEndpoint: "...", tokenPath: "..." }
}]
```

> **Note:** To load OpenAPI specs from files, use [`loadResources()`](./loaders.md) or import the file yourself.

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
}]
```

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
      region: "us-east-1",
      accessKeyId: "...",
      secretAccessKey: "...",
      endpoint: "...",      // Custom S3 endpoint
    },
    
    inlineThresholdBytes: 100_000,  // Max size for inline assets
    resolveInLLM: true,             // Resolve asset refs for LLM
  },
  
  // OR provide existing store
  store: existingAssetStore,
}
```

## Runtime Defaults

```typescript
stream: false,              // Enable streaming by default
queueTTL: 3600000,         // Queue item TTL (1 hour)
namespace: "default",       // Default namespace
threadMetadata: {           // Metadata for new threads
  source: "api",
  version: "1.0",
},
activeTaskId: "task-123",   // Default task context
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
