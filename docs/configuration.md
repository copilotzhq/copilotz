# Configuration

This document covers all configuration options for `createCopilotz` and `run`.

## CopilotzConfig

The main configuration object passed to `createCopilotz`:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  // Agents (required unless resources.path is set)
  agents: [...],
  
  // File-based resources and bundled presets
  resources: {
    path: "./resources",
    preset: ["core", "code"],
    imports: ["channels.whatsapp", "tools.read_file"],
    filterResources: (resource, type) => true,
    watch: false,            // Reserved for future use
  },
  
  // Database
  dbConfig: { ... },
  dbInstance: existingDb,
  
  // Tools & Integrations
  tools: [...],
  apis: [...],
  mcpServers: [...],
  
  // Skills
  skills: [...],
  agentsFile: {
    enabled: true,           // Default: true
    fileName: "AGENTS.md",   // Default: AGENTS.md
  },
  
  // Copilotz native assistant
  copilotzAgent: { llmOptions: { ... } },
  
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
});
```

## Resources

Load agents, tools, APIs, processors, providers, and other resources from a
directory structure instead of (or in addition to) defining them inline. When
`resources.path` is set, `createCopilotz` automatically calls `loadResources`
internally and merges the results with any explicit config.

```typescript
// File-based only — agents loaded from resources/agents/
const copilotz = await createCopilotz({
  resources: { path: "./resources" },
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
  stream: true,
});

// Mixed — bundled core + code tools + selected file-loaded resources
const copilotz = await createCopilotz({
  resources: {
    path: "./resources",
    preset: ["core", "code"],
    imports: ["channels.whatsapp", "tools.read_file"],
  },
  tools: [myExtraTool], // Appended to file-loaded tools
  agents: [{ id: "assistant" }], // Replaces file-loaded "assistant" (ID collision)
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
});
```

### Merge Behavior

When both `resources.path` and explicit arrays are provided:

- **Append**: Explicit items are added after file-loaded ones
- **Override on ID collision**: If an explicit item has the same `id` (or
  `key`/`name`) as a file-loaded one, the explicit item wins
- **Processors**: Always appended (no ID-based dedup)

### Options

```typescript
resources: {
  path: "./resources",           // Path to resources directory (relative to cwd or absolute)
  preset: ["core"],              // Bundled presets; built-ins default to ["core"]
  imports: ["tools.read_file"],  // Pre-load selectors (dot notation)
  filterResources: (resource, type) => true, // Only post-load filter hook
  watch: false,                  // Reserved for future live-reload support
}
```

### Presets and Imports

- `preset` loads named bundled groups such as `core`, `rag`, `admin`, and `code`
- bundled/native resources always include `core`, even if you only pass
  additional presets such as `["code"]`
- `imports` narrows loading with dot notation like `channels`,
  `channels.whatsapp`, or `tools.read_file`
- Presets and imports are additive unions
- `resources.filterResources` runs after loading and merging; there is no
  top-level `filterResources` anymore

See [Resource Loaders](./loaders.md) for the expected directory structure.

## Local AGENTS Instructions

Copilotz can automatically load an `AGENTS.md`-style instruction file from the
current working directory and append it to the active agent's prompt at run
time. This is enabled by default.

```typescript
agentsFile: {
  enabled: true,
  fileName: "AGENTS.md",
}
```

Set `agentsFile: false` to disable it entirely.

## Agents

```typescript
agents: [{
  id: "assistant", // Unique identifier (required)
  name: "Assistant", // Display name (required)
  role: "assistant", // "assistant", "system", or "user" (required)
  instructions: "Be helpful.", // System prompt
  llmOptions: { // LLM configuration (required)
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096, // Max response length
    limitEstimatedInputTokens: 12000, // Approximate input/history budget (1 token ~= 4 chars)
    baseUrl: "...", // Custom endpoint
    outputReasoning: false, // Default true; whether to emit reasoning tokens ("thinking") during stream
    estimateCost: true, // Default true; estimate cost from OpenRouter pricing when native usage exists
    pricingModelId: "openai/gpt-4o-mini", // Optional explicit OpenRouter model id override
  },
  allowedTools: ["*"], // Tool whitelist
  allowedAgents: ["other"], // Agent communication whitelist
  ragOptions: { // Per-agent RAG settings
    mode: "auto",
    namespaces: ["docs"],
    autoInjectLimit: 4,
    entityExtraction: { enabled: true },
  },
  assetOptions: { // Per-agent asset generation settings
    produce: {
      persistGeneratedAssets: true,
    },
  },
}];
```

`llmOptions` is persisted as an `LLMConfig`, so only non-secret fields should be
treated as durable configuration. Runtime-only fields such as API keys should
come from environment variables, agent runtime config, or the
`security.resolveLLMRuntimeConfig` hook described below.

`limitEstimatedInputTokens` limits the prompt history using Copilotz's rough
token estimator (`1 token ~= 4 characters`). It is an approximate input budget,
not a model-specific tokenizer count.

### Cost Estimation

Copilotz can estimate LLM call cost using OpenRouter's model pricing catalog.

```typescript
llmOptions: {
  provider: "openai",
  model: "gpt-5-mini",
  estimateCost: true,                // Default: true
  pricingModelId: "openai/gpt-5-mini", // Optional override when auto-mapping is not enough
}
```

Behavior:

- Cost estimation is enabled by default for LLM calls
- Set `estimateCost: false` to opt out for an agent
- Copilotz fetches and caches the OpenRouter models catalog lazily
- Failures in pricing lookup never fail the LLM request; cost is simply omitted
  and a warning is logged
- Cost is only estimated when the provider returned native usage data
- When Copilotz falls back to its rough token heuristic, usage is still recorded
  but cost is not estimated

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

The `staleProcessingThresholdMs` option provides automatic recovery from server
crashes:

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

- Events stuck in `"processing"` status longer than the threshold are
  automatically reset to `"pending"`
- This prevents permanent deadlocks when the server crashes mid-processing
- Default: 5 minutes (300000ms)
- Set lower for faster recovery, higher for long-running operations

**When to adjust:**

- **Lower (1-2 min)**: Fast recovery, but may reset legitimately slow operations
- **Higher (10-15 min)**: For operations that genuinely take a long time
- **Default (5 min)**: Good balance for most use cases

## Skills

Load remote or inline skills in addition to skills discovered from
`resources/skills/`, `~/.copilotz/skills/`, and bundled skills.

```typescript
skills: [
  // Remote skill from URL
  "https://example.com/skills/my-skill/SKILL.md",

  // Remote skill with explicit URL
  { url: "https://example.com/skills/other/SKILL.md" },

  // Inline skill
  {
    name: "custom-workflow",
    description: "Guide through the custom workflow.",
    content: "# Custom Workflow\n\nStep-by-step instructions...",
  },
];
```

Skills are merged with precedence: project > explicit > user > bundled. See
[Skills](./skills.md) for the full SKILL.md format, discovery system, and native
tools.

## Copilotz Agent

Enable the bundled Copilotz assistant — a general-purpose Copilotz-native helper
with access to the bundled skills and file tools:

```typescript
copilotzAgent: {
  llmOptions: { provider: "openai", model: "gpt-4o" },
  allowedTools: ["persistent_terminal"],
  instructions: "Operate only through the persistent terminal.",
}

// Or override any normal agent fields
copilotzAgent: {
  id: "dev-assistant",
  name: "Dev Assistant",
  llmOptions: { provider: "anthropic", model: "claude-sonnet-4-5-20241022" },
  allowedSkills: ["create-agent"],
}
```

The Copilotz agent is added alongside your existing agents. Bundled admin
defaults are applied first, and any fields you provide in `copilotzAgent`
override them. If you define an agent with the same ID (`"copilotz"` by
default), your explicit agent definition still takes precedence.

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
}];
```

`historyPolicy.visibility` supports:

- `requester_only`
- `public_result`
- `public_full`

Use `projector` with `public_result` when other agents should see a compact
business-level outcome instead of the raw tool payload.

## OpenAPI Integrations

```typescript
apis: [{
  id: "github",
  name: "GitHub API",
  openApiSchema: myOpenApiSchema, // Object or JSON/YAML string (NOT a file path)
  baseUrl: "https://api.github.com", // Override spec base URL
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
}];
```

> **Note:** To load OpenAPI specs from files, use
> [`loadResources()`](./loaders.md) or import the file yourself.
>
> `toolPolicies` are keyed by the generated tool key, usually the OpenAPI
> `operationId`.

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

For MCP servers, overrides can be keyed by either the generated Copilotz tool
key (`serverName_toolName`) or the original MCP tool name.

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

## History Transform

Use `historyTransform` to filter or rewrite the generated message history before
it is sent to the LLM.

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

- Runs after Copilotz generates chat history and before the system prompt is
  added
- Receives both normalized `messages` and aligned `rawHistory`
- Must return the final `ChatMessage[]` to send as history
- May be async
- Does not receive or modify the agent system prompt

Use this hook for redaction, age-based filtering, attachment stripping, or
tenant-specific history rules. If you need to change instructions, do that in
the agent configuration instead.

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
- When the counter reaches `maxAgentTurns`, the next message targets the
  original human user
- Human messages reset the counter to 0

### Target Context in History

When `includeTargetContext` is true (default), chat history includes addressing
info:

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
```

---

## RunOptions

Options passed to `copilotz.run()`:

```typescript
await copilotz.run(message, {
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

Use `target` and `targetQueue` to route messages programmatically without
relying on @mentions:

```typescript
// Route directly to a specific agent
await copilotz.run(
  {
    content: "Process this data",
    sender: { type: "user", name: "Alex" },
    target: "data-processor",
  },
  onEvent,
);

// Route to multiple agents in sequence
await copilotz.run(
  {
    content: "Review and approve",
    sender: { type: "user", name: "Alex" },
    targetQueue: ["reviewer", "approver"],
  },
  onEvent,
);
```

When `targetQueue` is provided without `target`, the first item in the queue
becomes the primary target and the remaining items stay queued.

---

## Environment Variables

LLM provider keys can be set via environment variables:

| Provider              | Environment Variable                |
| --------------------- | ----------------------------------- |
| OpenAI                | `OPENAI_API_KEY`                    |
| Anthropic             | `ANTHROPIC_API_KEY`                 |
| Gemini                | `GEMINI_API_KEY`                    |
| Groq                  | `GROQ_API_KEY`                      |
| DeepSeek              | `DEEPSEEK_API_KEY`                  |
| Ollama                | `OLLAMA_API_KEY` (or use `baseUrl`) |
| Any provider fallback | `LLM_API_KEY`                       |

The library checks `${PROVIDER}_API_KEY` first, then falls back to
`LLM_API_KEY`.

## Runtime Secret Resolution

Use `security.resolveLLMRuntimeConfig` when your runtime needs to inject secrets
or other execution-time overrides without persisting them in `LLM_CALL` events.

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    llmOptions: {
      provider: "openai",
      model: "gpt-4o-mini",
    },
  }],
  security: {
    resolveLLMRuntimeConfig: async ({ provider, agent, config }) => {
      if (provider === "openai" && agent.name === "Assistant") {
        return {
          apiKey: Deno.env.get("OPENAI_API_KEY"),
        };
      }

      return {
        apiKey: Deno.env.get("LLM_API_KEY"),
      };
    },
  },
});
```

Resolution model:

- `LLMConfig`: persisted and streamed safe config
- `LLMRuntimeConfig`: execution-time config used for the provider call
- built-in env lookup still works even if no security hook is provided

---

## Complete Example

```typescript
import {
  createCopilotz,
  defineCollection,
  index,
  relation,
} from "@copilotz/copilotz";

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
  { namespace: "workspace:123" },
);

await result.done;
await copilotz.shutdown();
```

## Next Steps

- [Getting Started](./getting-started.md) — Quick start guide
- [Skills](./skills.md) — SKILL.md format, discovery, and the native assistant
- [Agents](./agents.md) — Agent configuration details
- [API Reference](./api-reference.md) — Full API documentation
