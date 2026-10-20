import type { ActionInvocationMetadata } from "@copilotz/copilotz/actions";
/** Shared contracts for the semantic Server facade plugin. @module */

export type {
  ServerCollectionMutationConstraints,
  ServerCollectionMutationPolicy,
  ServerConstraints,
} from "@copilotz/copilotz/engine";

export const SERVER_RESOURCE_NAMESPACE = "server";
export const SERVER_RESOURCE_ALIAS = "default";
/** Default maximum raw request body accepted by POST /assets. */
export const DEFAULT_SERVER_ASSET_UPLOAD_BYTES = 20 * 1024 * 1024;

export type ServerHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type ServerPatternPolicy = Readonly<{
  include?: readonly string[];
  exclude?: readonly string[];
}>;

export type ServerCollectionExposure = Readonly<
  & ServerPatternPolicy
  & {
    operations?: boolean | ServerPatternPolicy;
  }
>;

export type ServerExposureOptions = Readonly<{
  actions?: boolean | ServerPatternPolicy;
  collections?: boolean | ServerCollectionExposure;
  channels?: boolean | ServerPatternPolicy;
}>;

export type ServerEndpointKind =
  | "action"
  | "operation"
  | "http"
  | "collection"
  | "channel"
  | "asset"
  | "agents"
  | "openapi";

export type ServerEndpointDescriptor = Readonly<{
  key: string;
  kind: ServerEndpointKind;
  id: string;
  method: ServerHttpMethod;
  path: string;
  operation?: string;
  actionAlias?: string;
  collectionAlias?: string;
  member?: string;
  inputSchema?: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  responseMediaType?: string;
}>;

export type ServerAuthorizedScope = Readonly<{
  authority?: import("@copilotz/copilotz/engine").AuthenticatedAuthority;
  actor?: Readonly<
    { id: string; externalId?: string; name?: string; email?: string }
  >;
  namespace?: string;
  databaseSchema?: string;
  identity?: Readonly<{
    correlationId?: string;
    causationId?: string;
    deduplicationId?: string;
  }>;
  actionMetadata?: ActionInvocationMetadata;
  /** Trusted opaque host claims used only for operation ownership/routing. */
  operationMetadata?: Readonly<Record<string, unknown>>;
  context?: Readonly<Record<string, unknown>>;
}>;

export type ServerAuthenticationContext = Readonly<{
  lookup(
    scope: Pick<ServerAuthorizedScope, "namespace" | "databaseSchema">,
  ): Promise<import("../authoring/http-adapter/index.ts").HttpReadServices>;
  endpoint: ServerEndpointDescriptor;
  params: Readonly<Record<string, string>>;
  defaultNamespace?: string;
  defaultDatabaseSchema: string;
}>;
export type ServerAuthenticate = (
  request: Request,
  context: ServerAuthenticationContext,
) =>
  | ServerAuthorizedScope
  | Response
  | Promise<ServerAuthorizedScope | Response>;
export type SessionCookieOptions = Readonly<{
  name?: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}>;
export type ServerFacadeResource = Readonly<{
  basePath: string;
  sessionCookie?: SessionCookieOptions;
  /** Maximum raw bytes accepted by the generic asset upload endpoint. */
  maxAssetUploadBytes: number;
  expose: Readonly<{
    actions: boolean | ServerPatternPolicy;
    collections: boolean | ServerCollectionExposure;
    channels: boolean | ServerPatternPolicy;
  }>;
  authenticate?: ServerAuthenticate;
  /** Exact custom HTTP route IDs allowed to establish bootstrap provenance, never user identity. */
}>;

export type DefineServerFacadeInput = Readonly<{
  basePath?: string;
  sessionCookie?: SessionCookieOptions;
  /** Defaults to 20 MiB. */
  maxAssetUploadBytes?: number;
  expose?: ServerExposureOptions;
  authenticate?: ServerAuthenticate;
  /** Exact custom HTTP route IDs allowed to establish bootstrap provenance, never user identity. */
}>;

export {
  parseServerActionRequest,
  parseServerCollectionMutationRequest,
  SERVER_ACTION_METADATA_SCHEMA,
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  SERVER_COLLECTION_MUTATION_METADATA_SCHEMA,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
  serverActionRequestSchema,
  serverCollectionMutationRequestSchema,
} from "@copilotz/copilotz/engine";
export type {
  ServerActionRequest,
  ServerCollectionMutationRequest,
} from "@copilotz/copilotz/engine";
