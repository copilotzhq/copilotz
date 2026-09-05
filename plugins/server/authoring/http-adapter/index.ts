/** Exact application endpoints contributed through the existing Adapter category. @module */
import type {
  CollectionQuery,
  CollectionRecord,
} from "@copilotz/copilotz/collections";
import type {
  ServerAuthorizedScope,
  ServerConstraints,
  ServerEndpointDescriptor,
  ServerHttpMethod,
} from "../../internal/contracts.ts";

export type HttpReadServices = Readonly<{
  get(collection: string, id: string): Promise<CollectionRecord | null>;
  list(
    collection: string,
    query?: CollectionQuery,
  ): Promise<readonly CollectionRecord[]>;
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
  /** Enforced policy; handlers may tighten it but cannot remove it from services. */
  constraints: ServerConstraints;
  read: HttpReadServices;
  invoke(
    actionId: string,
    input: unknown,
    options?: {
      idempotencyKey?: string;
      actionMetadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown>;
  content: Readonly<{ get(assetId: string): Promise<Response> }>;
  operations: Readonly<{
    checkpoint(threadId: string): Promise<string>;
    observe(
      selection: {
        threadId?: string;
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
export type HttpAdapter = Readonly<{ routes: readonly HttpRoute[] }>;

export function createHttpAdapter(input: HttpAdapter): HttpAdapter {
  const ids = new Set<string>();
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const routes = input.routes.map((route) => {
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
    return Object.freeze({
      ...route,
      ...(route.metadata
        ? { metadata: freeze(structuredClone(route.metadata)) }
        : {}),
      ...(route.inputSchema
        ? { inputSchema: freeze(structuredClone(route.inputSchema)) }
        : {}),
      ...(route.outputSchema
        ? { outputSchema: freeze(structuredClone(route.outputSchema)) }
        : {}),
    });
  });
  return Object.freeze({ routes: Object.freeze(routes) });
}
