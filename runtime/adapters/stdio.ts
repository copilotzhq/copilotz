import { createServerWorkflowToolCatalog } from "./server-tool-catalog.ts";
import { connectStdioMcp } from "./stdio-mcp.ts";
import type { CreateStdioServerWorkflowToolCatalogOptions } from "./types.ts";
import type { WorkflowToolCatalog } from "../workflows/index.ts";

export { connectStdioMcp } from "./stdio-mcp.ts";
export type { CreateStdioServerWorkflowToolCatalogOptions } from "./types.ts";

/**
 * Grants the first-party subprocess-backed MCP stdio transport explicitly.
 * Import this factory only in hosts that support child processes.
 */
export function createStdioServerWorkflowToolCatalog(
  options: CreateStdioServerWorkflowToolCatalogOptions = {},
): WorkflowToolCatalog {
  return createServerWorkflowToolCatalog({
    ...options,
    connectMcp: connectStdioMcp,
  });
}
