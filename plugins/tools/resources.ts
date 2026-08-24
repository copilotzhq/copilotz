import type { ScopedCollection } from "@copilotz/copilotz/collections";
import type {
  ActionInvocationMetadata,
  RuntimeIdentity,
} from "@copilotz/copilotz/actions";
import type { ToolHistory } from "./contracts.ts";

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
  apiId: string;
  apiName: string;
  actionAlias: string;
  actionId: string;
  actionRunId: string;
  operationKey: string;
  identity: RuntimeIdentity;
  actionMetadata: ActionInvocationMetadata;
  signal: AbortSignal;
  namespace: string;
  /** Tenant-scoped graph collections available to this Action execution. */
  collections: Readonly<Record<string, ScopedCollection>>;
  resolveAsset: (
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

type APIResponseAssetMappingOptions = Readonly<{
  nameField?: string;
  /** Response field receiving the canonical ContentRef. Defaults to `asset`. */
  outputField?: string;
  /** Missing or null source fields are omitted instead of failing the Action. */
  optional?: boolean;
  /** Allowed response media types. Supports exact values and `type/*`. */
  mediaTypes?: readonly string[];
  /** Maximum decoded byte length. Defaults to 20 MiB. */
  maxBytes?: number;
}>;

/** Top-level response field promoted into one canonical tool attachment. */
export type APIResponseAssetMapping =
  & APIResponseAssetMappingOptions
  & Readonly<
    | {
      /** Raw base64 field paired with a separate media-type field. */
      dataBase64Field: string;
      mediaTypeField: string;
      dataUrlField?: never;
    }
    | {
      /** Complete `data:<media-type>;base64,...` response field. */
      dataUrlField: string;
      dataBase64Field?: never;
      mediaTypeField?: never;
    }
  >;

/** One attachment mapping or a batch promoted from the same API response. */
export type APIResponseAssetMappings =
  | APIResponseAssetMapping
  | readonly APIResponseAssetMapping[];

/** OpenAPI-backed Tool Resource definition owned by the Tools plugin. */
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
  /** Consume append-only application/x-ndjson output records plus one result. */
  streamNdjson?: boolean | null;
  prepareRequest?: APIPrepareRequest | null;
  /** Tool key to explicit response fields promoted into canonical attachments. */
  responseAssets?: Readonly<Record<string, APIResponseAssetMappings>>;
  metadata?: Readonly<Record<string, unknown>> | null;
  historyPolicyDefaults?: ToolHistory;
  toolPolicies?: Readonly<Record<string, ToolHistory>>;
}>;

export type NewAPI = Partial<API> & Pick<API, "name">;

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
