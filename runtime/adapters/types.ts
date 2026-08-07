import type { MCPServer } from "../resources/index.ts";
import type {
  GenerateApiWorkflowTools,
  WorkflowToolCatalog,
} from "../workflows/index.ts";

export type McpToolDescriptor = Readonly<{
  name: string;
  description?: string;
  inputSchema?: unknown;
}>;

/** Runtime-owned MCP connection. Copilotz closes every connection it opens. */
export type McpRuntimeConnection = Readonly<{
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void | Promise<void>;
}>;

/** Capability adapter supplied by the runtime hosting the worker. */
export type ConnectMcpRuntime = (
  server: MCPServer,
  signal?: AbortSignal,
) => Promise<McpRuntimeConnection>;

export type CreateMcpWorkflowToolGeneratorOptions = Readonly<{
  connect: ConnectMcpRuntime;
}>;

export type CreateServerWorkflowToolCatalogOptions = Readonly<{
  /** OpenAPI generation uses Web fetch at execution time. Defaults to true. */
  openApi?: boolean;
  /** Grant an MCP placement/transport while retaining catalog semantics. */
  connectMcp?: ConnectMcpRuntime;
  /** Override OpenAPI generation for a custom runtime. */
  generateApiTools?: GenerateApiWorkflowTools;
}>;

export type CreateStdioServerWorkflowToolCatalogOptions = Omit<
  CreateServerWorkflowToolCatalogOptions,
  "connectMcp"
>;

export type CreateServerWorkflowToolCatalog = (
  options?: CreateServerWorkflowToolCatalogOptions,
) => WorkflowToolCatalog;
