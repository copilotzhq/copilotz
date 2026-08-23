import type {
  GenerateApiWorkflowTools,
  WorkflowToolCatalog,
} from "../internal/types.ts";
import type { ConnectMcpRuntime } from "../mcp/types.ts";

export type CreateServerWorkflowToolCatalogOptions = Readonly<{
  /** OpenAPI generation uses Web fetch at execution time. Defaults to true. */
  openApi?: boolean;
  /** Grant an MCP placement/transport while retaining catalog semantics. */
  connectMcp?: ConnectMcpRuntime;
  /** Override OpenAPI generation for a custom runtime. */
  generateApiTools?: GenerateApiWorkflowTools;
}>;

export type CreateServerWorkflowToolCatalog = (
  options?: CreateServerWorkflowToolCatalogOptions,
) => WorkflowToolCatalog;
