---
name: configure-mcp
description: Add MCP server resources and explicitly inject a host transport.
allowed-tools: [read_file, write_file]
tags: [framework, mcp, plugin, adapter]
---

# Configure MCP

MCP servers are logical plugin resources. Transport placement belongs to the
host, so a portable plugin describes a server but does not spawn a process.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { MCPServer } from "jsr:@copilotz/copilotz@3/resources";

const filesystem: MCPServer = {
  id: "filesystem",
  name: "filesystem",
  transport: {
    type: "stdio",
    command: "node",
    args: ["./mcp-server.js"],
  },
  historyPolicyDefaults: { visibility: "requester_only" },
};

export const filesystemPlugin = definePlugin({
  manifest: {
    id: "@acme/filesystem-mcp",
    version: "1.0.0",
    provides: { mcpServers: [filesystem.id] },
  },
  resources: { mcpServers: [filesystem] },
});
```

## Node, Deno, or Bun stdio host

```ts
import { createStdioServerWorkflowToolCatalog } from "jsr:@copilotz/copilotz@3/adapters/stdio";

const app = await createCopilotz({
  plugins: [filesystemPlugin],
  core: {
    text: { toolCatalog: createStdioServerWorkflowToolCatalog() },
  },
});
```

The stdio subpath is intentionally host-only. Never import it from browser or
Cloudflare-compatible core code.

## Portable or remote host

```ts
import { createServerWorkflowToolCatalog } from "jsr:@copilotz/copilotz@3/adapters";

const catalog = createServerWorkflowToolCatalog({
  connectMcp: appOwnedTransport.connect,
});
```

The injected connector owns the transport mechanics. Copilotz opens a logical
connection for discovery/execution and closes connections it opens. Grant
generated tool keys through each agent's `allowedTools`, and keep credentials in
the host rather than serialized resource descriptors.
