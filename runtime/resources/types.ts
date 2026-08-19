import type { ProviderConfig, ProviderFallbackConfig } from "../llm/types.ts";
import type { ScopedEventCollection } from "../domain/index.ts";

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

export type AgentRuntimeMode = "generate" | "session";

export type AgentRuntimeFallback = ProviderFallbackConfig;

/** One lifecycle mode. An array on Agent is at most one runtime per mode. */
export type AgentRuntime =
  & Omit<ProviderConfig, "provider" | "model" | "fallbacks">
  & Readonly<{
    mode?: AgentRuntimeMode;
    provider: string;
    model?: string;
    input?: readonly ("text" | "image" | "audio" | "video" | "file")[];
    output?: readonly ("text" | "image" | "audio" | "video" | "file")[];
    options?: Readonly<Record<string, unknown>>;
    fallbacks?: readonly AgentRuntimeFallback[];
    voice?: string;
  }>;

/** Explicit resource grant. Omission grants nothing; broad access is opt-in. */
export type CapabilitySelection =
  | readonly string[]
  | Readonly<{
    all: true;
    except?: readonly string[];
  }>;

export type AgentCapabilities = Readonly<{
  tools?: CapabilitySelection;
  agents?: CapabilitySelection;
  skills?: CapabilitySelection;
}>;

export type Agent = Readonly<{
  id: string;
  name: string;
  externalId?: string | null;
  role: string;
  personality?: string | null;
  instructions?: string | null;
  description?: string | null;
  /** Least-authority grants resolved against composed plugin resources. */
  capabilities?: AgentCapabilities;
  metadata?: Readonly<Record<string, unknown>> | null;
  /** Generate/session adapter selection. Failovers stay in the same mode. */
  runtime?: AgentRuntime | readonly AgentRuntime[];
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
  /** Trusted physical schema selected by the application boundary. */
  databaseSchema?: string;
  /** Tenant-scoped graph collections available to this tool execution. */
  collections?: Readonly<Record<string, ScopedEventCollection>>;
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

/** Top-level response fields promoted into one canonical tool attachment. */
export type APIResponseAssetMapping = Readonly<{
  dataBase64Field: string;
  mediaTypeField: string;
  nameField?: string;
}>;

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
  /** Consume application/x-ndjson records as live tool output plus one result. */
  streamNdjson?: boolean | null;
  prepareRequest?: APIPrepareRequest | null;
  /** Tool key to response-field mapping for automatic canonical attachments. */
  responseAssets?: Readonly<Record<string, APIResponseAssetMapping>>;
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

/** Agent Skills specification metadata parsed from `SKILL.md`. */
export type SkillManifest = Readonly<{
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Readonly<Record<string, string>>;
  /** Experimental spec field. It describes compatibility, not authority. */
  allowedTools?: string;
}>;

export type SkillFileDescriptor = Readonly<{
  /** Portable, slash-separated path relative to the skill root. */
  path: string;
  mediaType: string;
  size?: number;
  /** Content digest such as `sha256:<hex>`. */
  digest?: string;
}>;

export type SkillFileBody =
  | string
  | Uint8Array
  | ReadableStream<Uint8Array>;

export type SkillFile =
  & SkillFileDescriptor
  & Readonly<{
    body: SkillFileBody;
  }>;

export type SkillReadOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Runtime-neutral lazy representation of one Agent Skills directory. */
export type Skill =
  & SkillManifest
  & Readonly<{
    files: readonly SkillFileDescriptor[];
    read(path: string, options?: SkillReadOptions): Promise<SkillFile>;
  }>;

export type SkillIndexEntry = Pick<
  SkillManifest,
  "name" | "description" | "compatibility"
>;
