import type { ActionInvocationMetadata } from "@copilotz/copilotz/actions";
/** Shared contracts for the semantic Server facade plugin. @module */

import type { CollectionFilter } from "@copilotz/copilotz/collections";

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

/** Trusted policy applied to one durable collection mutation. */
export type ServerCollectionMutationPolicy = Readonly<{
  /** Fields accepted from the caller. `id` is implicit for member writes. */
  fields?: readonly string[];
  /** Exact values enforced on the mutation input. */
  input?: Readonly<Record<string, unknown>>;
  /** Existing-record scope. This is also checked against the resulting record. */
  filter?: CollectionFilter;
}>;

/** Mutation policy is deliberately separate from read collection filters. */
export type ServerCollectionMutationConstraints = Readonly<{
  create?: ServerCollectionMutationPolicy;
  update?: ServerCollectionMutationPolicy;
  delete?: ServerCollectionMutationPolicy;
  commands?: Readonly<Record<string, ServerCollectionMutationPolicy>>;
}>;

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
export type ServerConstraints = Readonly<{
  /** Host-selected conversation group for bounded HTTP admission. */
  admission?: Readonly<{ key: string; threadId?: string }>;
  input?: Readonly<Record<string, unknown>>;
  actionMetadata?: ActionInvocationMetadata;
  collections?: Readonly<
    Record<string, import("@copilotz/copilotz/collections").CollectionFilter>
  >;
  /** Explicit write policy; read filters never authorize mutations. */
  collectionMutations?: Readonly<
    Record<string, ServerCollectionMutationConstraints>
  >;
  operations?: Readonly<{ metadata: Readonly<Record<string, unknown>> }>;
}>;
export type ServerAuthorize = (
  request: Request,
  context:
    & ServerAuthenticationContext
    & Readonly<{
      scope: ServerAuthorizedScope;
      read: import("../authoring/http-adapter/index.ts").HttpReadServices;
    }>,
) => ServerConstraints | Response | Promise<ServerConstraints | Response>;

export type ServerFacadeResource = Readonly<{
  basePath: string;
  /** Maximum raw bytes accepted by the generic asset upload endpoint. */
  maxAssetUploadBytes: number;
  expose: Readonly<{
    actions: boolean | ServerPatternPolicy;
    collections: boolean | ServerCollectionExposure;
    channels: boolean | ServerPatternPolicy;
  }>;
  authenticate?: ServerAuthenticate;
  authorize?: ServerAuthorize;
}>;

export type DefineServerFacadeInput = Readonly<{
  basePath?: string;
  /** Defaults to 20 MiB. */
  maxAssetUploadBytes?: number;
  expose?: ServerExposureOptions;
  authenticate?: ServerAuthenticate;
  authorize?: ServerAuthorize;
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
  ServerInvokeRequest,
} from "@copilotz/copilotz/engine";
