---
name: configure-mcp
description: Add an MCP (Model Context Protocol) server integration to provide tools to agents.
allowed-tools: [read_file, write_file]
tags: [framework, mcp]
---

# Configure MCP Server

MCP servers provide additional tools to agents via the Model Context Protocol.

## Add to createCopilotz Config

```typescript
const copilotz = await createCopilotz({
    agents: [...],
    mcpServers: [{
        id: "filesystem",
        name: "File System",
        transport: {
            type: "stdio",
            command: "node",
            args: ["./mcp-server.js"],
            env: { ROOT_DIR: "/data" },
        },
    }],
    dbConfig: { url: "..." },
});
```

## File-Based Configuration

```
resources/mcp-servers/{server-name}/
  config.ts    # MCP server configuration
```

```typescript
import type { MCPServer } from "copilotz";

export default {
    id: "filesystem",
    name: "File System",
    transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
    },
    historyPolicyDefaults: {
        visibility: "requester_only",
    },
    toolPolicies: {
        read_file: { visibility: "requester_only" },
        list_directory: {
            visibility: "public_result",
            projector: (_args, output) => {
                const result = output as { entries?: unknown[] };
                return `Listed ${result.entries?.length ?? 0} entries.`;
            },
        },
    },
} as MCPServer;
```

## Transport Types

- `stdio`: Communicate via stdin/stdout with a child process
- `sse`: Connect to an SSE endpoint (for remote MCP servers)

## Tool Naming

MCP tools are exposed as `{serverId}_{toolName}`. Agents access them via `allowedTools`.

## Notes

- MCP tools are auto-discovered from the server at startup
- Tool policies can override visibility per-tool using either the Copilotz key or original MCP tool name
