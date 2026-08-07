import { assertEquals, assertRejects } from "@std/assert";

import type { Agent, API, MCPServer } from "../resources/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { createWorkflowToolCatalog } from "./tool-catalog.ts";
import type { WorkflowTool } from "./types.ts";

function tool(key: string, source: string): WorkflowTool {
  return {
    id: `${source}:${key}`,
    key,
    name: key,
    description: `${source} ${key}`,
    inputSchema: { type: "object", properties: {} },
    execute: () => source,
  };
}

const api: API = {
  id: "contract-api",
  name: "Contract API",
  openApiSchema: { openapi: "3.0.0", paths: {} },
};

const mcpServer: MCPServer = {
  id: "contract-mcp",
  name: "Contract MCP",
  transport: { type: "contract" },
};

Deno.test("worker-local tool catalog caches descriptors and keeps explicit-tool precedence", async () => {
  const explicit = tool("collision", "explicit");
  const plugin = definePlugin({
    manifest: {
      id: "contract.catalog",
      version: "1.0.0",
      provides: {
        tools: [explicit.key],
        apis: [api.id],
        mcpServers: [mcpServer.id],
      },
    },
    resources: {
      tools: [explicit],
      apis: [api],
      mcpServers: [mcpServer],
    },
  });
  const resources = await createPluginRegistry({ plugins: [plugin] });
  let apiGenerations = 0;
  let mcpGenerations = 0;
  const catalog = createWorkflowToolCatalog({
    generateApiTools(apis) {
      apiGenerations += 1;
      assertEquals(apis, [api]);
      return [tool("collision", "api"), tool("api_only", "api")];
    },
    async generateMcpTools(servers) {
      mcpGenerations += 1;
      assertEquals(servers, [mcpServer]);
      return [tool("mcp_only", "mcp")];
    },
  });

  const all = await catalog.all(resources);
  assertEquals(all.map((candidate) => candidate.key), [
    "collision",
    "api_only",
    "mcp_only",
  ]);
  assertEquals(await all[0].execute({}), "explicit");

  const agent: Agent = {
    id: "north",
    name: "north",
    role: "assistant",
    instructions: "Use generated tools.",
    allowedTools: ["mcp_only", "collision"],
  };
  assertEquals(
    (await catalog.forAgent(resources, agent)).map((candidate) =>
      candidate.key
    ),
    ["mcp_only", "collision"],
  );
  assertEquals((await catalog.get(resources, "api_only"))?.key, "api_only");
  assertEquals(apiGenerations, 1);
  assertEquals(mcpGenerations, 1);

  catalog.clear();
  await catalog.all(resources);
  assertEquals(apiGenerations, 2);
  assertEquals(mcpGenerations, 2);
});

Deno.test("worker-local tool catalog rejects unknown agent allow-list keys", async () => {
  const resources = await createPluginRegistry();
  const catalog = createWorkflowToolCatalog({
    generateApiTools: () => [],
    generateMcpTools: () => [],
  });
  await assertRejects(
    () =>
      catalog.forAgent(resources, {
        id: "north",
        name: "north",
        role: "assistant",
        instructions: "No tools.",
        allowedTools: ["missing"],
      }),
    Error,
    "allows unknown tool 'missing'",
  );
});

Deno.test("worker-local tool catalog keeps static tools capability-free", async () => {
  const explicit = tool("portable", "application");
  const plugin = definePlugin({
    manifest: {
      id: "contract.static-catalog",
      version: "1.0.0",
      provides: { tools: [explicit.key] },
    },
    resources: { tools: [explicit] },
  });
  const resources = await createPluginRegistry({ plugins: [plugin] });
  const catalog = createWorkflowToolCatalog();
  assertEquals(await catalog.all(resources), [explicit]);
});
