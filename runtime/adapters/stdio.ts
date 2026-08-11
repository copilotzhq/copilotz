import { createServerWorkflowToolCatalog as createGenericServerWorkflowToolCatalog } from "./server-tool-catalog.ts";
import { connectMcp } from "./stdio-mcp.ts";
import type { CreateServerWorkflowToolCatalogOptions as GenericCatalogOptions } from "./types.ts";
import type { WorkflowToolCatalog } from "../workflows/index.ts";

export { connectMcp } from "./stdio-mcp.ts";
export type CreateServerWorkflowToolCatalogOptions = Omit<
  GenericCatalogOptions,
  "connectMcp"
>;

/**
 * Grants the first-party subprocess-backed MCP stdio transport explicitly.
 * Import this factory only in hosts that support child processes.
 */
export function createServerWorkflowToolCatalog(
  options: CreateServerWorkflowToolCatalogOptions = {},
): WorkflowToolCatalog {
  return createGenericServerWorkflowToolCatalog({
    ...options,
    connectMcp,
  });
}
