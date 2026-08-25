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

export type ServerHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "QUERY";

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

export type ServerRouteOverride = false | Readonly<{ path: string }>;

export type ServerOverrideOptions = Readonly<{
  actions?: Readonly<Record<string, ServerRouteOverride>>;
  collections?: Readonly<Record<string, ServerRouteOverride>>;
  channels?: Readonly<Record<string, ServerRouteOverride>>;
}>;

export type ServerEndpointKind =
  | "action"
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
}>;

export type ServerAuthorizedScope = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  identity?: Readonly<{
    correlationId?: string;
    causationId?: string;
    deduplicationId?: string;
  }>;
  actionMetadata?: ActionInvocationMetadata;
  context?: Readonly<Record<string, unknown>>;
}>;

export type ServerGuardContext = Readonly<{
  endpoint: ServerEndpointDescriptor;
  defaultNamespace?: string;
  defaultDatabaseSchema: string;
  /** Trusted process-local context resolved by the host HTTP boundary. */
  requestContext?: Readonly<Record<string, unknown>>;
}>;

export type ServerGuard = (
  request: Request,
  context: ServerGuardContext,
) =>
  | void
  | ServerAuthorizedScope
  | Response
  | Promise<void | ServerAuthorizedScope | Response>;

export type ServerFacadeResource = Readonly<{
  basePath: string;
  expose: Readonly<{
    actions: boolean | ServerPatternPolicy;
    collections: boolean | ServerCollectionExposure;
    channels: boolean | ServerPatternPolicy;
  }>;
  overrides: Readonly<{
    actions: Readonly<Record<string, ServerRouteOverride>>;
    collections: Readonly<Record<string, ServerRouteOverride>>;
    channels: Readonly<Record<string, ServerRouteOverride>>;
  }>;
  guard?: ServerGuard;
}>;

export type DefineServerFacadeInput = Readonly<{
  basePath?: string;
  expose?: ServerExposureOptions;
  overrides?: ServerOverrideOptions;
  guard?: ServerGuard;
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
