import type { ToolHistory } from "@copilotz/copilotz/core";
/** MCP server definition interpreted only by the MCP Tool integration. */
export type MCPServer = Readonly<{
  id: string;
  name: string;
  externalId?: string | null;
  description?: string | null;
  transport?: Readonly<Record<string, unknown>> | null;
  capabilities?: Readonly<Record<string, unknown>> | null;
  env?: Readonly<Record<string, unknown>> | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  historyPolicyDefaults?: ToolHistory;
  toolPolicies?: Readonly<Record<string, ToolHistory>>;
}>;

export type NewMCPServer = Partial<MCPServer> & Pick<MCPServer, "name">;
