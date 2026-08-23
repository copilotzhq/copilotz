import type { MCPServer } from "../resources.ts";

export type McpToolDescriptor = Readonly<{
  name: string;
  description?: string;
  inputSchema?: unknown;
}>;

/** Connection owned by the MCP Tool integration and closed after each use. */
export type McpRuntimeConnection = Readonly<{
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void | Promise<void>;
}>;

/** MCP transport supplied by the application hosting the Tool integration. */
export type ConnectMcpRuntime = (
  server: MCPServer,
  signal?: AbortSignal,
) => Promise<McpRuntimeConnection>;

export type CreateMcpToolsPluginOptions = Readonly<{
  servers: readonly MCPServer[];
  connect: ConnectMcpRuntime;
  signal?: AbortSignal;
  id?: string;
  version?: string;
}>;
