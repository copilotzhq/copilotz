/** Shared contracts for the semantic Server facade plugin. @module */

import type {
  ActionInvocationMetadata,
  ActionSchema,
} from "@copilotz/copilotz/actions";

export const SERVER_RESOURCE_NAMESPACE = "server";
export const SERVER_RESOURCE_ALIAS = "default";
export const SERVER_ACTION_REQUEST_EVENT_TYPE =
  "copilotz.server.action.requested";
export const SERVER_ACTION_REQUEST_SCHEMA = "copilotz.server.action-request.v1";
export const SERVER_ACTION_METADATA_SCHEMA = "copilotz.server.action.v1";
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

export type ServerActionRequest = Readonly<{
  schema: typeof SERVER_ACTION_REQUEST_SCHEMA;
  requestId: string;
  actionAlias: string;
  input: unknown;
  actionMetadata: ActionInvocationMetadata;
}>;

export type ServerInvokeRequest = Readonly<{
  requestId: string;
  actionAlias: string;
}>;

export function serverActionRequestSchema(
  inputSchema: ActionSchema | undefined,
): ActionSchema {
  return Object.freeze({
    type: "object",
    properties: Object.freeze({
      schema: Object.freeze({ const: SERVER_ACTION_REQUEST_SCHEMA }),
      requestId: Object.freeze({ type: "string", minLength: 1 }),
      actionAlias: Object.freeze({ type: "string", minLength: 1 }),
      input: inputSchema ?? Object.freeze({}),
      actionMetadata: Object.freeze({ type: "object" }),
    }),
    required: Object.freeze([
      "schema",
      "requestId",
      "actionAlias",
      "input",
      "actionMetadata",
    ]),
    additionalProperties: false,
  });
}

export function parseServerActionRequest(value: unknown): ServerActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Server Action request must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schema !== SERVER_ACTION_REQUEST_SCHEMA ||
    typeof input.requestId !== "string" || !input.requestId.trim() ||
    typeof input.actionAlias !== "string" || !input.actionAlias.trim() ||
    !input.actionMetadata || typeof input.actionMetadata !== "object" ||
    Array.isArray(input.actionMetadata) ||
    Reflect.ownKeys(input).some((key) =>
      key !== "schema" && key !== "requestId" && key !== "actionAlias" &&
      key !== "input" && key !== "actionMetadata"
    )
  ) throw new TypeError("Server Action request is invalid.");
  return Object.freeze({
    schema: SERVER_ACTION_REQUEST_SCHEMA,
    requestId: input.requestId.trim(),
    actionAlias: input.actionAlias.trim(),
    input: structuredClone(input.input),
    actionMetadata: Object.freeze(structuredClone(
      input.actionMetadata as Record<string, unknown>,
    )),
  });
}
