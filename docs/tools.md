# Tools

Tools let your agents interact with the world beyond conversation. Read files, make HTTP requests, search your knowledge base, or call external APIs — all through a unified interface.

## How Tools Work

When an agent needs to do something, it tells the LLM which tools are available. The LLM decides which tool to call and with what arguments. Copilotz executes the tool and feeds the result back to the LLM.

```
Agent receives message
    │
    ▼
LLM decides to use a tool
    │
    ▼
TOOL_CALL event created
    │
    ▼
Tool executed by Copilotz
    │
    ▼
Result sent back to LLM
    │
    ▼
LLM continues conversation
```

## Native Tools

Copilotz includes 24 built-in tools. Enable them per-agent with `allowedTools`:

```typescript
const agent = {
  id: "assistant",
  name: "Assistant",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  allowedTools: ["read_file", "write_file", "search_knowledge"],
};
```

### File Operations

| Tool | Description |
|------|-------------|
| `read_file` | Read contents of a file |
| `write_file` | Write content to a file (creates parent directories) |
| `list_directory` | List files and folders in a directory |
| `search_files` | Search for files matching a pattern |

### HTTP & Network

| Tool | Description |
|------|-------------|
| `http_request` | Full HTTP client (GET, POST, PUT, PATCH, DELETE) with headers and body |
| `fetch_text` | Simple URL fetch that returns text content |

### RAG & Knowledge

| Tool | Description |
|------|-------------|
| `search_knowledge` | Semantic search across your knowledge base |
| `ingest_document` | Add a document to the knowledge base (URL, file, or raw text) |
| `list_namespaces` | List all knowledge namespaces with document counts |
| `delete_document` | Remove a document from the knowledge base |

### Thread & Task Management

| Tool | Description |
|------|-------------|
| `create_thread` | Create a new conversation thread |
| `end_thread` | Archive a thread with a summary |
| `create_task` | Create a goal-oriented task |
| `ask_question` | Ask another agent a question and wait for response |

### Agent Memory

| Tool | Description |
|------|-------------|
| `update_my_memory` | Store persistent learnings (preferences, expertise, working memory) |

### Assets

| Tool | Description |
|------|-------------|
| `save_asset` | Store a file/image in the asset store, returns `asset://` reference |
| `fetch_asset` | Retrieve an asset as base64 or data URL |

### System & Utilities

| Tool | Description |
|------|-------------|
| `run_command` | Execute a system command (with security checks) |
| `get_current_time` | Get current time in various formats and timezones |
| `wait` | Pause for a specified duration (0.1-60 seconds) |
| `verbal_pause` | Create a conversational pause for emphasis |

## Agent Memory Tool

The `update_my_memory` tool allows agents to store persistent learnings that survive across conversations. This is useful for building agents that learn user preferences or accumulate expertise over time.

```typescript
const agent = {
  id: "personal-assistant",
  name: "Assistant",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  allowedTools: ["update_my_memory"],
};
```

### Memory Keys

| Key | Purpose |
|-----|---------|
| `workingMemory` | Short-term context for the current task |
| `expertise` | Skills and knowledge the agent has learned |
| `learnedPreferences` | User preferences discovered over time |

### Operations

```typescript
// Set a value (replaces existing)
update_my_memory({ key: "workingMemory", value: "Working on Q4 report", operation: "set" })

// Append to existing (comma-separated)
update_my_memory({ key: "learnedPreferences", value: "Prefers bullet points", operation: "append" })

// Remove a specific value or clear the key
update_my_memory({ key: "expertise", value: "Python", operation: "remove" })
```

### How It Works

1. Agent decides to remember something important
2. Calls `update_my_memory` with key, value, and operation
3. Memory is stored in the agent's participant node in the knowledge graph
4. On future conversations, memory is automatically injected into the system prompt

See [Agents](./agents.md#agent-persistent-memory) for more details.

## Custom Tools

Define your own tools with JSON Schema input/output and an execute function:

```typescript
const weatherTool = {
  id: "get_weather",
  name: "Get Weather",
  description: "Get the current weather for a location",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
      units: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" },
    },
    required: ["city"],
  },
  execute: async ({ city, units }) => {
    const response = await fetch(`https://api.weather.com/${city}`);
    const data = await response.json();
    return { temperature: data.temp, conditions: data.conditions };
  },
};

const copilotz = await createCopilotz({
  agents: [{
    // ...
    allowedTools: ["get_weather"],
  }],
  tools: [weatherTool],
});
```

## OpenAPI Tools

Generate tools automatically from OpenAPI 3.0 specifications. Each API operation becomes a callable tool.

```typescript
// Import or define your OpenAPI schema
const githubSchema = {
  openapi: "3.0.0",
  info: { title: "GitHub API", version: "1.0.0" },
  servers: [{ url: "https://api.github.com" }],
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "getRepository",
        summary: "Get a repository",
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
  },
};

const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["*"], // Allow all tools including API-generated
  }],
  apis: [{
    id: "github",
    name: "GitHub API",
    openApiSchema: githubSchema, // Object or JSON/YAML string
    auth: {
      type: "bearer",
      token: Deno.env.get("GITHUB_TOKEN"),
    },
  }],
});
```

> **Note:** `openApiSchema` accepts an object or a JSON/YAML string. To load from a file, use [`loadResources()`](./loaders.md) or import the file yourself.

### Authentication Options

```typescript
// API Key (header or query)
auth: { type: "apiKey", key: "X-API-Key", value: "your-key", in: "header" }

// Bearer Token
auth: { type: "bearer", token: "your-token" }

// Basic Auth
auth: { type: "basic", username: "user", password: "pass" }

// Dynamic Token (fetches token from auth endpoint)
auth: {
  type: "dynamic",
  authEndpoint: "https://api.example.com/oauth/token",
  tokenPath: "access_token",
  method: "POST",
  body: { client_id: "...", client_secret: "..." },
}
```

## MCP Tools

Integrate with Model Context Protocol servers. Tools from MCP servers appear alongside native tools.

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["*"],
  }],
  mcpServers: [{
    id: "filesystem",
    name: "File System MCP",
    transport: {
      type: "stdio",
      command: "node",
      args: ["./mcp-servers/filesystem.js"],
    },
  }],
});
```

## Tool Permissions

Control which tools each agent can access:

```typescript
// Explicit whitelist
allowedTools: ["read_file", "search_knowledge"]

// All tools
allowedTools: ["*"]

// All native tools plus specific custom tools
allowedTools: ["*native*", "my_custom_tool"]
```

## Tool Execution Context

Custom tools receive context about the current execution:

```typescript
const tool = {
  id: "context_aware_tool",
  // ...
  execute: async (input, context) => {
    // context includes:
    // - threadId: Current thread
    // - agentId: Agent calling the tool
    // - namespace: Current namespace
    // - schema: Current schema
    // - db: Database access
    // - assets: Asset store access
    
    const { threadId, namespace } = context;
    // Use context to scope operations
  },
};
```

## Next Steps

- [RAG](./rag.md) — Deep dive into knowledge base tools
- [Agents](./agents.md) — Configure tool permissions per agent
- [Configuration](./configuration.md) — API and MCP server configuration
