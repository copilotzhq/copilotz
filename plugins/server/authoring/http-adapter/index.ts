/** Exact application endpoints contributed through the existing Adapter category. @module */
import type {
  CollectionAggregateQuery,
  CollectionAggregateRow,
  CollectionQuery,
  CollectionRecord,
  CollectionSubscription,
  ScopedCollectionReadOptions,
  SubscriptionOptions,
} from "@copilotz/copilotz/collections";
import type {
  ServerAuthorizedScope,
  ServerEndpointDescriptor,
  ServerHttpMethod,
} from "../../shared/contracts.ts";

export type HttpReadServices = Readonly<{
  observe(
    collection: string,
    query?: CollectionQuery,
    options?: SubscriptionOptions,
  ): Promise<
    CollectionSubscription
  >;
  get(
    collection: string,
    id: string,
    options?: ScopedCollectionReadOptions,
  ): Promise<CollectionRecord | null>;
  list(
    collection: string,
    query?: CollectionQuery,
    options?: ScopedCollectionReadOptions,
  ): Promise<readonly CollectionRecord[]>;
  aggregate(
    collection: string,
    query: CollectionAggregateQuery,
    options?: ScopedCollectionReadOptions,
  ): Promise<readonly CollectionAggregateRow[]>;
  query(
    collection: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;
}>;
export type HttpHandlerContext = Readonly<{
  request: Request;
  endpoint: ServerEndpointDescriptor;
  params: Readonly<Record<string, string>>;
  input: unknown;
  scope: ServerAuthorizedScope;
  sessions: Readonly<
    {
      create(
        input: Readonly<{ id: string; principal: string; expiresAt: string }>,
      ): Promise<void>;
      revoke(id?: string): Promise<void>;
    }
  >;
  read: HttpReadServices;
  /** Returns the Action's durable result; observe its operation for scope settlement. */
  invoke(
    actionAlias: string,
    input: unknown,
    options?: {
      idempotencyKey?: string;
      actionMetadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown>;
  content: Readonly<{ get(assetId: string): Promise<Response> }>;
  operations: Readonly<{
    checkpoint(
      record: Readonly<{ collection: string; id: string }>,
      coverage?: { checkpoint: string; actionRunIds: readonly string[] },
    ): Promise<string>;
    observe(
      selection: {
        record?: Readonly<{ collection: string; id: string }>;
        operationIds?: readonly string[];
        checkpoint?: string;
      },
    ): Promise<Response>;
  }>;
}>;
export type HttpRoute = Readonly<
  & {
    id: string;
    method: ServerHttpMethod;
    path: string;
    inputSchema?: Readonly<Record<string, unknown>>;
    outputSchema?: Readonly<Record<string, unknown>>;
    /** Trusted endpoint policy labels, visible to authentication before body parsing. */
    metadata?: Readonly<Record<string, unknown>>;
    responseMediaType?: string;
    /** Bounded buffered request body. Default: 1 MiB, parsed by Content-Type. */
    body?: Readonly<{ maxBytes: number; raw?: boolean }>;
  }
  & (
    | {
      action: string;
      input?: (context: HttpHandlerContext) => unknown | Promise<unknown>;
      handler?: never;
    }
    | {
      handler: (context: HttpHandlerContext) => unknown | Promise<unknown>;
      action?: never;
    }
  )
>;
export type HttpObservationSelection = Readonly<{
  key(id: string): string;
  outputMetadata?(id: string): Readonly<Record<string, unknown>>;
}>;
export type HttpAdapter = Readonly<{
  /** Domain read projection, applied to every HTTP/device collection read. */
  reads?(
    read: HttpReadServices,
    scope: ServerAuthorizedScope,
  ): HttpReadServices;
  /** Domain content authorization in addition to the owner's asset grant. */
  authorizeAsset?(
    id: string,
    scope: ServerAuthorizedScope,
    read: HttpReadServices,
  ): Promise<void>;
  /** Authorize a retained Action result from its admitted invocation metadata. */
  authorizeActionResult?(
    metadata: Readonly<Record<string, unknown>>,
    scope: ServerAuthorizedScope,
  ): void;
  /** Domain projection shared by explicit operation and record observations. */
  projectOutput?(
    output: import("@copilotz/copilotz/streams").ApplicationOutput,
    scope: ServerAuthorizedScope,
    read: HttpReadServices,
    origins: (
      actionRunId: string,
    ) => Promise<readonly Readonly<Record<string, unknown>>[]>,
  ): Promise<import("@copilotz/copilotz/streams").ApplicationOutput | null>;

  /** Domain-owned selection keys, indexed by the authorized Collection alias. */
  observations?: Readonly<Record<string, HttpObservationSelection>>;
  /** Domain metadata for durable HTTP ingress, derived from trusted scope metadata. */
  ingressMetadata?(
    metadata: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  /** Collection aliases read by authenticated routes; checked at Server startup. */
  collections?: readonly string[];
  routes: readonly HttpRoute[];
}>;

export function createHttpAdapter(input: HttpAdapter): HttpAdapter {
  const ids = new Set<string>();
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      value;
    }
    return value;
  };
  const routes = input.routes.map((route) => {
    if (
      route.body && (
        !Number.isSafeInteger(route.body.maxBytes) || route.body.maxBytes < 1 ||
        (route.body.raw !== undefined && typeof route.body.raw !== "boolean")
      )
    ) {
      throw new TypeError(
        "HTTP body maxBytes must be a positive safe integer and raw must be boolean.",
      );
    }
    const parts = route.path.split("/").slice(1);
    const parameters = parts.filter((part) => part.startsWith(":"));
    if (
      !route.id.trim() || ids.has(route.id) ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method) ||
      !route.path.startsWith("/") || route.path.includes("*") ||
      parts.some((part) =>
        !part || /[?#%\\]/.test(part) ||
        (part.includes(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(part))
      ) ||
      new Set(parameters).size !== parameters.length ||
      route.path.split("/").some((part) =>
        part === "." || part === ".." || /^v[0-9]+$/.test(part)
      ) ||
      Boolean(route.action) === Boolean(route.handler)
    ) {
      throw new TypeError(
        "HTTP endpoints require an exact path and one Action or handler.",
      );
    }
    ids.add(route.id);
    return ({
      ...route,
      ...(route.body ? { body: Object.freeze({ ...route.body }) } : {}),
      ...(route.metadata
        ? { metadata: freeze(structuredClone(route.metadata)) }
        : {}),
      ...(route.inputSchema
        ? { inputSchema: freeze(structuredClone(route.inputSchema)) }
        : {}),
      ...(route.outputSchema
        ? { outputSchema: freeze(structuredClone(route.outputSchema)) }
        : {}),
    } as const);
  });
  return ({
    ...input,
    collections: input.collections?.slice(),
    routes,
  } as const);
}
