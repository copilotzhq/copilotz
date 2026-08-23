import { resolveToolGrants } from "@copilotz/copilotz/core";
import type { AgentResource } from "@copilotz/copilotz/core";
import type { Skill } from "@copilotz/copilotz/skills";
import type { API, MCPServer } from "../resources.ts";
import { isWorkflowTool, type WorkflowTool } from "./types.ts";
import type {
  CreateWorkflowToolCatalogOptions,
  WorkflowToolCatalog,
  WorkflowToolCatalogContext,
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
  resourceType: "api" | "mcp",
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
  agent: AgentResource,
  context: WorkflowToolCatalogContext,
): readonly WorkflowTool[] {
  return resolveToolGrants(agent, tools, {
    agents: Object.values(context.agents).filter((
      value,
    ): value is AgentResource => !!value),
    skills: Object.values(context.skills).filter((value): value is Skill =>
      !!value
    ),
  });
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
    unavailableGenerator<API>("api", "generateApiTools");
  const generateMcpTools = options.generateMcpTools ??
    unavailableGenerator<MCPServer>("mcp", "generateMcpTools");
  const entries: CatalogEntry[] = [];

  const generated = (
    context: WorkflowToolCatalogContext,
  ): Promise<readonly WorkflowTool[]> => {
    const apis = Object.values(context.apis).filter((value): value is API =>
      !!value
    );
    const mcpServers = Object.values(context.mcp).filter((
      value,
    ): value is MCPServer => !!value);
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
    context: WorkflowToolCatalogContext,
  ): Promise<readonly WorkflowTool[]> => {
    const staticTools = Object.values(context.tools).filter(isWorkflowTool);
    const generatedTools = await generated(context);
    return composeTools(staticTools, generatedTools, []);
  };

  return Object.freeze({
    all,
    async forAgent(context, agent) {
      return filterAgentTools(await all(context), agent, context);
    },
    async get(context, key) {
      return (await all(context)).find((tool) => tool.key === key);
    },
    clear() {
      entries.splice(0, entries.length);
    },
  });
}
