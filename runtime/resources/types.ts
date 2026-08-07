import type { ProviderConfig } from "../llm/types.ts";

export type ToolHistoryVisibility =
  | "requester_only"
  | "public_status"
  | "public";

export type ToolHistoryPolicy = Readonly<{
  visibility?: ToolHistoryVisibility;
}>;

export type ToolExecute = {
  bivarianceHack(
    args: unknown,
    context?: unknown,
  ): unknown | Promise<unknown>;
}["bivarianceHack"];

/** Logical tool resource. Execution receives a workflow-owned typed context. */
export type Tool = Readonly<{
  id: string;
  key: string;
  name: string;
  externalId?: string | null;
  description: string;
  inputSchema?: Readonly<Record<string, unknown>> | null;
  outputSchema?: Readonly<Record<string, unknown>> | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  execute?: ToolExecute;
  historyPolicy?: ToolHistoryPolicy;
}>;

export type NewTool =
  & Partial<Tool>
  & Pick<Tool, "key" | "name" | "description">;

export type AgentTextRuntime = Readonly<{
  type: "llm";
  provider: string;
  model?: string;
}>;

export type AgentRealtimeRuntime = Readonly<{
  type: "realtime";
  provider: string;
  model?: string;
  voice?: string;
}>;

export type AgentRuntimes = Readonly<{
  text?: AgentTextRuntime;
  realtime?: AgentRealtimeRuntime;
}>;

export type Agent = Readonly<{
  id: string;
  name: string;
  externalId?: string | null;
  role: string;
  personality?: string | null;
  instructions?: string | null;
  description?: string | null;
  allowedAgents?: readonly string[] | null;
  allowedTools?: readonly string[] | null;
  allowedSkills?: readonly string[] | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  /** Shorthand for `runtimes.text`; dynamic policy belongs in the text plugin. */
  llmOptions?: ProviderConfig;
  runtimes?: AgentRuntimes;
  ragOptions?: Readonly<Record<string, unknown>>;
  assetOptions?: Readonly<{
    resolveInLLM?: boolean;
    produce?: Readonly<{ persistGeneratedAssets?: boolean }>;
  }>;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}>;

export type NewAgent = Partial<Agent> & Pick<Agent, "name" | "role">;

export type ReasoningHistoryInclude = "none" | "self" | "all";

export type ReasoningHistoryOptions = Readonly<{
  include?: ReasoningHistoryInclude;
  maxEstimatedTokens?: number;
}>;

export type APIAuth =
  | Readonly<{
    type: "apiKey";
    in: "header" | "query";
    name: string;
    key: string;
  }>
  | Readonly<{ type: "bearer"; scheme?: string; token: string }>
  | Readonly<{ type: "basic"; username: string; password: string }>
  | Readonly<{
    type: "custom";
    headers?: Readonly<Record<string, string>> | null;
    queryParams?: Readonly<Record<string, string | number | boolean>> | null;
  }>
  | Readonly<{
    type: "dynamic";
    authEndpoint: Readonly<{
      url: string;
      method?: string;
      headers?: Readonly<Record<string, string>> | null;
      body?: unknown;
      credentials?: unknown;
    }>;
    tokenExtraction: Readonly<{
      path?: string | null;
      type: "bearer" | "apiKey";
      prefix?: string | null;
      headerName?: string | null;
    }>;
    cache?: Readonly<{ enabled: boolean; duration: number }> | null;
    refreshConfig?:
      | Readonly<{
        refreshEndpoint?: string | null;
        refreshBeforeExpiry?: number | null;
        refreshPath?: string | null;
        expiryPath?: string | null;
      }>
      | null;
  }>;

export type APIPrepareRequestInput = {
  url: string;
  method: string;
  headers: Record<string, string>;
  queryParams: URLSearchParams;
  body?: unknown;
};

export type APIPrepareRequestContext = Readonly<{
  apiName: string;
  toolKey: string;
  toolExecutionId?: string;
  toolCallId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  threadId?: string;
  senderId?: string;
  senderType?: "human" | "agent" | "tool" | "system" | "job";
  userExternalId?: string;
  agent?: Agent | null;
  namespace?: string;
  userMetadata?: Readonly<Record<string, unknown>>;
  threadMetadata?: Readonly<Record<string, unknown>>;
  resolveAsset?: (
    assetId: string,
  ) => Promise<{ bytes: Uint8Array; mime: string }>;
}>;

export type APIPrepareRequest = (
  request: APIPrepareRequestInput,
  context: APIPrepareRequestContext,
) =>
  | APIPrepareRequestInput
  | undefined
  | Promise<APIPrepareRequestInput | undefined>;

export type API = Readonly<{
  id: string;
  name: string;
  externalId?: string | null;
  description?: string | null;
  openApiSchema?: Readonly<Record<string, unknown>> | string | null;
  baseUrl?: string | null;
  headers?: Readonly<Record<string, string>> | null;
  auth?: APIAuth | null;
  timeout?: number | null;
  includeResponseHeaders?: boolean | null;
  prepareRequest?: APIPrepareRequest | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  historyPolicyDefaults?: ToolHistoryPolicy;
  toolPolicies?: Readonly<Record<string, ToolHistoryPolicy>>;
}>;

export type NewAPI = Partial<API> & Pick<API, "name">;

export type MCPServer = Readonly<{
  id: string;
  name: string;
  externalId?: string | null;
  description?: string | null;
  transport?: Readonly<Record<string, unknown>> | null;
  capabilities?: Readonly<Record<string, unknown>> | null;
  env?: Readonly<Record<string, unknown>> | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  historyPolicyDefaults?: ToolHistoryPolicy;
  toolPolicies?: Readonly<Record<string, ToolHistoryPolicy>>;
}>;

export type NewMCPServer = Partial<MCPServer> & Pick<MCPServer, "name">;

export type Skill = Readonly<{
  name: string;
  description: string;
  content: string;
  allowedTools?: readonly string[];
  tags?: readonly string[];
  source: "project" | "user" | "bundled" | "remote";
  sourcePath: string;
  hasReferences: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type SkillIndexEntry = Readonly<{
  name: string;
  description: string;
  tags?: readonly string[];
}>;
