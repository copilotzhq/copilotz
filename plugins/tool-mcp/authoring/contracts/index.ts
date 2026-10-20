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
  /** Host-reviewed read-only tool names. Provider hints alone do not grant replay. */
  readOnlyTools?: readonly string[];
  toolPolicies?: Readonly<Record<string, ToolHistory>>;
}>;

export type NewMCPServer = Partial<MCPServer> & Pick<MCPServer, "name">;
