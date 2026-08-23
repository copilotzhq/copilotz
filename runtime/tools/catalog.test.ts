import { assertEquals, assertRejects } from "@std/assert";

import type { Agent, API, MCPServer } from "../resources/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { createWorkflowToolCatalog } from "./catalog.ts";
import type { WorkflowTool } from "./types.ts";

type TestRegistry = Awaited<ReturnType<typeof createPluginRegistry>>;

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

function catalogContext(resources: TestRegistry) {
  return Object.freeze({
    agents: (resources.resources.agents ?? Object.freeze({})) as Record<
      string,
      Agent | undefined
    >,
    skills: Object.freeze({}),
    tools: (resources.resources.tools ?? Object.freeze({})) as Record<
      string,
      WorkflowTool | undefined
    >,
    apis: (resources.resources.apis ?? Object.freeze({})) as Record<
      string,
      API | undefined
    >,
    mcp: (resources.resources.mcp ?? Object.freeze({})) as Record<
      string,
      MCPServer | undefined
    >,
  });
}

Deno.test("worker-local tool catalog caches descriptors and keeps explicit-tool precedence", async () => {
  const explicit = tool("collision", "explicit");
  const plugin = definePlugin({
    id: "contract.catalog",
    version: "1.0.0",
    resources: {
      tools: { [explicit.key]: explicit },
      apis: { [api.id]: api },
      mcp: { [mcpServer.id]: mcpServer },
    },
  });
  const resources = catalogContext(
    await createPluginRegistry({ plugins: [plugin] }),
  );
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
    capabilities: { tools: ["mcp_only", "collision"] },
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

Deno.test("worker-local tool catalog rejects unknown explicit grants", async () => {
  const resources = catalogContext(await createPluginRegistry());
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
        capabilities: { tools: ["missing"] },
      }),
    Error,
    "grants unknown tool 'missing'",
  );
});

Deno.test("worker-local tool catalog installs tools without ambient agent grants", async () => {
  const explicit = tool("portable", "application");
  const plugin = definePlugin({
    id: "contract.static-catalog",
    version: "1.0.0",
    resources: { tools: { [explicit.key]: explicit } },
  });
  const resources = catalogContext(
    await createPluginRegistry({ plugins: [plugin] }),
  );
  const catalog = createWorkflowToolCatalog();
  assertEquals(await catalog.all(resources), [explicit]);
  assertEquals(
    await catalog.forAgent(resources, {
      id: "restricted",
      name: "Restricted",
      role: "assistant",
    }),
    [],
  );
  assertEquals(
    await catalog.forAgent(resources, {
      id: "broad",
      name: "Broad",
      role: "assistant",
      capabilities: { tools: { all: true } },
    }),
    [explicit],
  );
});
