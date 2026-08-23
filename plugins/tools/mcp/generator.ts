import type { MCPServer } from "@copilotz/copilotz/resources";
import type {
  GenerateMcpWorkflowTools,
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import type {
  CreateMcpWorkflowToolGeneratorOptions,
  McpRuntimeConnection,
  McpToolDescriptor,
} from "./types.ts";

export type {
  ConnectMcpRuntime,
  CreateMcpWorkflowToolGeneratorOptions,
  McpRuntimeConnection,
  McpToolDescriptor,
} from "./types.ts";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function allowedToolNames(server: MCPServer): ReadonlySet<string> | undefined {
  const configured = server.capabilities?.tools;
  if (!Array.isArray(configured)) return undefined;
  return new Set(
    configured.filter((value): value is string =>
      typeof value === "string" && Boolean(value.trim())
    ).map((value) => value.trim()),
  );
}

async function withConnection<T>(
  connect: CreateMcpWorkflowToolGeneratorOptions["connect"],
  server: MCPServer,
  signal: AbortSignal | undefined,
  operation: (connection: McpRuntimeConnection) => Promise<T>,
): Promise<T> {
  const connection = await connect(server, signal);
  try {
    return await operation(connection);
  } finally {
    await connection.close();
  }
}

function toolFrom(
  server: MCPServer,
  descriptor: McpToolDescriptor,
  connect: CreateMcpWorkflowToolGeneratorOptions["connect"],
): WorkflowTool {
  const serverId = requiredText(server.id, "MCP server id");
  const serverName = requiredText(server.name, "MCP server name");
  const toolName = requiredText(descriptor.name, "MCP tool name");
  const key = `${serverName}_${toolName}`;
  const execute = async (
    args: unknown,
    context?: WorkflowToolExecutionContext,
  ): Promise<unknown> =>
    await withConnection(
      connect,
      server,
      context?.processor.signal,
      (connection) =>
        connection.callTool(
          toolName,
          record(args),
          context?.processor.signal,
        ),
    );
  return Object.freeze({
    id: `mcp:${serverId}:${toolName}`,
    key,
    name: `${serverName}: ${toolName}`,
    description: descriptor.description?.trim() ||
      `${
        server.description?.trim() ? `${server.description}: ` : ""
      }${toolName}`,
    externalId: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    inputSchema: record(descriptor.inputSchema),
    outputSchema: null,
    historyPolicy: server.toolPolicies?.[key] ??
      server.toolPolicies?.[toolName] ?? server.historyPolicyDefaults,
    execute,
  });
}

async function toolsForServer(
  server: MCPServer,
  connect: CreateMcpWorkflowToolGeneratorOptions["connect"],
): Promise<readonly WorkflowTool[]> {
  const descriptors = await withConnection(
    connect,
    server,
    undefined,
    (connection) => connection.listTools(),
  );
  const allowed = allowedToolNames(server);
  return Object.freeze(
    descriptors
      .filter((descriptor) => !allowed || allowed.has(descriptor.name))
      .map((descriptor) => toolFrom(server, descriptor, connect)),
  );
}

/**
 * Creates worker-local MCP tools from serializable server descriptors.
 * Discovery and each execution own a short-lived connection, so no client or
 * transport leaks into durable worker payloads or application shutdown.
 */
export function createMcpWorkflowToolGenerator(
  options: CreateMcpWorkflowToolGeneratorOptions,
): GenerateMcpWorkflowTools {
  if (typeof options?.connect !== "function") {
    throw new TypeError("An MCP runtime connector is required.");
  }
  return async (servers) =>
    Object.freeze(
      (await Promise.all(
        servers.map((server) => toolsForServer(server, options.connect)),
      )).flat(),
    );
}
