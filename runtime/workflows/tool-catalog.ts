import type { Agent, API, MCPServer } from "../resources/index.ts";
import type { ScopedPluginResources } from "../engine/index.ts";
import { isWorkflowTool } from "./resources.ts";
import type {
  CreateWorkflowToolCatalogOptions,
  WorkflowTool,
  WorkflowToolCatalog,
} from "./types.ts";

type CatalogEntry = {
  apis: readonly API[];
  mcpServers: readonly MCPServer[];
  tools: Promise<readonly WorkflowTool[]>;
};

function sameResources<T extends object>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return left.length === right.length &&
    left.every((resource, index) => resource === right[index]);
}

function unavailableGenerator<T extends object>(
  resourceType: "apis" | "mcpServers",
  adapter: string,
): (resources: readonly T[]) => readonly WorkflowTool[] {
  return (resources) => {
    if (resources.length === 0) return Object.freeze([]);
    throw new Error(
      `Plugin resources '${resourceType}' require an explicit tool-catalog adapter. ` +
        `Inject ${adapter} into createWorkflowToolCatalog(), or use ` +
        "createServerWorkflowToolCatalog() in a server runtime.",
    );
  };
}

function composeTools(
  staticTools: readonly WorkflowTool[],
  apiTools: readonly WorkflowTool[],
  mcpTools: readonly WorkflowTool[],
): readonly WorkflowTool[] {
  const byKey = new Map<string, WorkflowTool>();
  // Explicit tool resources have precedence. Generated catalogs retain their
  // declared order and cannot silently replace a previously exposed key.
  for (const tool of [...staticTools, ...apiTools, ...mcpTools]) {
    if (!byKey.has(tool.key)) byKey.set(tool.key, tool);
  }
  return Object.freeze([...byKey.values()]);
}

function filterAgentTools(
  tools: readonly WorkflowTool[],
  agent: Agent,
): readonly WorkflowTool[] {
  if (agent.allowedTools === undefined) return tools;
  if (!Array.isArray(agent.allowedTools) || agent.allowedTools.length === 0) {
    return Object.freeze([]);
  }
  const byKey = new Map(tools.map((tool) => [tool.key, tool]));
  return Object.freeze(agent.allowedTools.map((key) => {
    const tool = byKey.get(key);
    if (!tool) {
      throw new Error(`Agent '${agent.id}' allows unknown tool '${key}'.`);
    }
    return tool;
  }));
}

/**
 * Creates a worker-local catalog from static, OpenAPI, and MCP plugin
 * resources. Generated executors are cached by descriptor identity so prompt
 * generation and durable execution resolve the same logical tool instances.
 */
export function createWorkflowToolCatalog(
  options: CreateWorkflowToolCatalogOptions = {},
): WorkflowToolCatalog {
  const generateApiTools = options.generateApiTools ??
    unavailableGenerator<API>("apis", "generateApiTools");
  const generateMcpTools = options.generateMcpTools ??
    unavailableGenerator<MCPServer>("mcpServers", "generateMcpTools");
  const entries: CatalogEntry[] = [];

  const generated = (
    resources: ScopedPluginResources,
  ): Promise<readonly WorkflowTool[]> => {
    const apis = resources.list<API>("apis");
    const mcpServers = resources.list<MCPServer>("mcpServers");
    const cached = entries.find((entry) =>
      sameResources(entry.apis, apis) &&
      sameResources(entry.mcpServers, mcpServers)
    );
    if (cached) return cached.tools;

    const entry: CatalogEntry = {
      apis,
      mcpServers,
      tools: Promise.all([
        generateApiTools(apis),
        generateMcpTools(mcpServers),
      ]).then(([apiTools, mcpTools]) =>
        composeTools(
          [],
          apiTools.filter(isWorkflowTool),
          mcpTools.filter(isWorkflowTool),
        )
      ),
    };
    entries.push(entry);
    entry.tools.catch(() => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    });
    return entry.tools;
  };

  const all = async (
    resources: ScopedPluginResources,
  ): Promise<readonly WorkflowTool[]> => {
    const staticTools = resources.list<WorkflowTool>("tools").filter(
      isWorkflowTool,
    );
    const generatedTools = await generated(resources);
    return composeTools(staticTools, generatedTools, []);
  };

  return Object.freeze({
    all,
    async forAgent(resources, agent) {
      return filterAgentTools(await all(resources), agent);
    },
    async get(resources, key) {
      return (await all(resources)).find((tool) => tool.key === key);
    },
    clear() {
      entries.splice(0, entries.length);
    },
  });
}
