import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import type { API, MCPServer } from "../resources/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { createWorkflowToolCatalog } from "../tools/index.ts";
import { createMcpWorkflowToolGenerator } from "./mcp-tools.ts";
import { createServerWorkflowToolCatalog } from "./server-tool-catalog.ts";
import type { McpRuntimeConnection } from "./types.ts";

const api: API = {
  id: "contract-api",
  name: "Contract API",
  baseUrl: "https://example.test",
  openApiSchema: {
    openapi: "3.0.0",
    paths: {
      "/lookup": {
        get: {
          operationId: "api_lookup",
          description: "Lookup a contract value.",
        },
      },
    },
  },
};

const mcpServer: MCPServer = {
  id: "contract-mcp",
  name: "contract",
  transport: { type: "contract" },
  capabilities: { tools: ["ping"] },
};

async function resourcesFor(input: {
  apis?: readonly API[];
  mcpServers?: readonly MCPServer[];
}) {
  const plugin = definePlugin({
    manifest: {
      id: "test.catalog-adapters",
      version: "1.0.0",
      provides: {
        ...(input.apis ? { api: input.apis.map((value) => value.id) } : {}),
        ...(input.mcpServers
          ? { mcp: input.mcpServers.map((value) => value.id) }
          : {}),
      },
    },
    resources: {
      ...(input.apis ? { api: input.apis } : {}),
      ...(input.mcpServers ? { mcp: input.mcpServers } : {}),
    },
  });
  return await createPluginRegistry({ plugins: [plugin] });
}

Deno.test("runtime-neutral catalogs require explicit adapters only when descriptors exist", async () => {
  const empty = await createPluginRegistry();
  assertEquals(await createWorkflowToolCatalog().all(empty), []);

  const apiResources = await resourcesFor({ apis: [api] });
  await assertRejects(
    () => createWorkflowToolCatalog().all(apiResources),
    Error,
    "Plugin resources 'api' require an explicit tool-catalog adapter",
  );

  const mcpResources = await resourcesFor({ mcpServers: [mcpServer] });
  await assertRejects(
    () => createWorkflowToolCatalog().all(mcpResources),
    Error,
    "Plugin resources 'mcp' require an explicit tool-catalog adapter",
  );
});

Deno.test("factory MCP adapter discovers and executes logical tools with owned connections", async () => {
  let connections = 0;
  let closes = 0;
  const calls: Array<Readonly<{ name: string; args: unknown }>> = [];
  const connect = async (): Promise<McpRuntimeConnection> => {
    connections += 1;
    let closed = false;
    return Object.freeze({
      async listTools() {
        return [
          {
            name: "ping",
            description: "Ping",
            inputSchema: { type: "object" },
          },
          { name: "hidden", description: "Hidden" },
        ];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return { pong: args };
      },
      close() {
        if (closed) return;
        closed = true;
        closes += 1;
      },
    });
  };
  const resources = await resourcesFor({ mcpServers: [mcpServer] });
  const catalog = createWorkflowToolCatalog({
    generateApiTools: () => [],
    generateMcpTools: createMcpWorkflowToolGenerator({ connect }),
  });

  const tools = await catalog.all(resources);
  assertEquals(tools.map((tool) => ({ id: tool.id, key: tool.key })), [{
    id: "mcp:contract-mcp:ping",
    key: "contract_ping",
  }]);
  assertEquals(connections, 1);
  assertEquals(closes, 1);
  assertEquals(await tools[0].execute({ value: 42 }), {
    pong: { value: 42 },
  });
  assertEquals(calls, [{ name: "ping", args: { value: 42 } }]);
  assertEquals(connections, 2);
  assertEquals(closes, 2);
});

Deno.test("first-party server catalog preserves OpenAPI generation as an explicit grant", async () => {
  const resources = await resourcesFor({ apis: [api] });
  const catalog = createServerWorkflowToolCatalog();
  const tools = await catalog.all(resources);
  assertEquals(tools.map((tool) => tool.key), ["api_lookup"]);
  assert(tools[0].id?.startsWith("api:contract-api:"));
});

Deno.test("generic server catalog never grants stdio implicitly", async () => {
  const resources = await resourcesFor({ mcpServers: [mcpServer] });
  await assertRejects(
    () => createServerWorkflowToolCatalog().all(resources),
    Error,
    "Plugin resources 'mcp' require an explicit tool-catalog adapter",
  );
});

Deno.test("adapter boundary is factory-first and leaves runtime APIs out of core", async () => {
  const core = await Deno.readTextFile(
    new URL("../tools/catalog.ts", import.meta.url),
  );
  assert(!core.includes('import("../api/index.ts")'));
  assert(!core.includes('import("../mcp/index.ts")'));
  for (
    const module of [
      "mcp-tools.ts",
      "server-tool-catalog.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\./.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/^\s*(?:export\s+)?class\s/m.test(source));
    assertStringIncludes(
      source,
      module === "mcp-tools.ts" ? "function" : "export",
    );
  }
});
