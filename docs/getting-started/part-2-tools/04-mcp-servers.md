# Chapter 4: MCP Servers

> **Part 2 — Tools: From Custom to Protocol**

## The pain

Your agent needs to interact with Slack, GitHub, a Postgres database, a Notion workspace. Each integration requires you to:

1. Find and read the service's API docs
2. Write a tool wrapper for each endpoint you need
3. Handle auth, rate limits, and error formats per-service
4. Keep everything in sync as APIs evolve

This is sustainable for one service. It becomes a maintenance burden for three. It's untenable for ten.

What you want is a standard protocol where tools from any service just... plug in. That protocol exists.

## The solution

**MCP (Model Context Protocol)** is an open standard for connecting AI agents to external tools and data sources. An MCP server exposes its capabilities in a standardized way, and any MCP-compatible agent can use them immediately — no custom integration code.

Copilotz supports MCP natively. Point `mcpServers` at any running MCP server and its tools become available to your agents.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "An assistant with access to GitHub and a local filesystem.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      // allowedTools: undefined means all registered tools are available
    },
  ],
  mcpServers: [
    {
      id: "github",
      name: "GitHub MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: Deno.env.get("GITHUB_TOKEN") ?? "",
      },
    },
    {
      id: "filesystem",
      name: "Filesystem MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"],
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "GitHub + filesystem assistant ready.\n" });
```

The agent now has every tool that the GitHub MCP server exposes — list repos, create issues, read files, open PRs — without you writing a single integration.

## MCP transport types

MCP supports multiple transports. Copilotz supports `stdio` (subprocess) and HTTP-based transports:

### stdio (subprocess)
Spins up a local process and communicates over stdin/stdout. Best for local development and CLI-distributed MCP servers.

```typescript
{
  id: "postgres",
  name: "Postgres MCP",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
}
```

### HTTP (remote server)
Connects to a remote MCP server over HTTP. Best for shared infrastructure and production deployments.

```typescript
{
  id: "my-company-mcp",
  name: "Company Tools",
  transport: "http",
  url: "https://mcp.mycompany.com/api",
  headers: {
    Authorization: `Bearer ${Deno.env.get("MCP_TOKEN")}`,
  },
}
```

## Popular MCP servers

The MCP ecosystem is growing rapidly. Some commonly used servers:

| Server | What it provides |
|--------|-----------------|
| `@modelcontextprotocol/server-github` | GitHub repos, issues, PRs, code |
| `@modelcontextprotocol/server-filesystem` | Local file read/write |
| `@modelcontextprotocol/server-postgres` | PostgreSQL queries |
| `@modelcontextprotocol/server-slack` | Slack messages and channels |
| `@modelcontextprotocol/server-brave-search` | Web search via Brave |
| `@modelcontextprotocol/server-google-maps` | Location and directions |

Find more at [mcp.so](https://mcp.so) and [smithery.ai](https://smithery.ai).

## Mixing MCP tools with custom and native tools

All tool types are unified. An agent can use native tools, custom tools, and MCP tools in the same conversation:

```typescript
const copilotz = await createCopilotz({
  agents: [
    {
      id: "developer",
      allowedTools: [
        "read_file",           // native tool
        "run_command",         // native tool
        "lookup_internal_db",  // custom tool
        // MCP tools are available by their server-reported names
      ],
    },
  ],
  tools: [lookupInternalDbTool],
  resources: {
    imports: ["tools.read_file", "tools.run_command"],
  },
  mcpServers: [
    { id: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  ],
  // ...
});
```

## Scoping MCP tools to specific agents

If you have multiple agents and want to limit which MCP tools each can access, use `allowedTools` with the MCP tool names (as reported by the server):

```typescript
{
  id: "code-reviewer",
  allowedTools: [
    "read_file",
    // GitHub MCP tool names — check the server's documentation for exact names
    "github_list_pull_requests",
    "github_get_pull_request",
    "github_create_review",
  ],
}
```

## What this unlocks

- Any MCP-compatible server becomes a set of agent tools instantly
- No per-service integration code
- A growing ecosystem of community-maintained servers
- Mix MCP, native, and custom tools freely

## What's next

MCP coverage is growing but not universal. Many services still only expose REST APIs — and they probably won't publish an MCP server any time soon. Can you still use them without writing every tool by hand?

→ **[Chapter 5: OpenAPI as Tools](./05-openapi-as-tools.md)**
