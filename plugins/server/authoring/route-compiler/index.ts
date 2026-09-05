/** Compiles composed primitives into one immutable Server route table. @module */

import { openApi } from "./openapi.ts";
import type { PluginRegistry } from "@copilotz/copilotz/plugins";
import { SERVER_INVOKE_ACTION_ID } from "../../actions/invoke-action/index.ts";
import type {
  ServerCollectionExposure,
  ServerEndpointDescriptor,
  ServerFacadeResource,
  ServerHttpMethod,
  ServerPatternPolicy,
} from "../../internal/contracts.ts";

export type CompiledServerRoute = Readonly<{
  endpoint: ServerEndpointDescriptor;
  segments: readonly string[];
}>;

export type ServerRouteMatch = Readonly<{
  endpoint: ServerEndpointDescriptor;
  params: Readonly<Record<string, string>>;
}>;

export type CompiledServerRoutes = Readonly<{
  basePath: string;
  routes: readonly CompiledServerRoute[];
  openApi: Readonly<Record<string, unknown>>;
  match(method: string, pathname: string): ServerRouteMatch | null;
}>;

function glob(pattern: string, value: string): boolean {
  const expression = pattern.split("*").map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function enabled(
  policy: boolean | ServerPatternPolicy,
  value: string,
): boolean {
  if (policy === false) return false;
  if (policy === true) return true;
  const include = policy.include ?? ["*"];
  const exclude = policy.exclude ?? [];
  return include.some((pattern) => glob(pattern, value)) &&
    !exclude.some((pattern) => glob(pattern, value));
}

function operationEnabled(
  policy: boolean | ServerCollectionExposure,
  operation: string,
): boolean {
  if (policy === false) return false;
  if (policy === true || policy.operations === undefined) return true;
  return enabled(policy.operations, operation);
}

function pathSegments(path: string): readonly string[] {
  return Object.freeze(
    path.split("/").filter(Boolean).map((segment) => {
      if (segment.startsWith(":")) return segment;
      return decodeURIComponent(segment);
    }),
  );
}

function canonicalActionPath(id: string): string {
  return `/actions/${id.split(".").map(encodeURIComponent).join("/")}`;
}

function canonicalCollectionPath(name: string): string {
  return `/collections/${encodeURIComponent(name)}`;
}

function canonicalChannelPath(alias: string): string {
  return `/channels/${encodeURIComponent(alias)}`;
}

function endpoint(
  value: Omit<ServerEndpointDescriptor, "key">,
): ServerEndpointDescriptor {
  return Object.freeze({
    ...value,
    key: `${value.method}:${value.path}`,
  });
}

function cloneSchema(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return deepFreeze(structuredClone(value as Record<string, unknown>));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** Compiles one complete registry into deterministic routes and OpenAPI. */
export function compileServerRoutes(
  registry: PluginRegistry,
  facade: ServerFacadeResource,
): CompiledServerRoutes {
  const endpoints: ServerEndpointDescriptor[] = [];
  const channelAliases = new Set(
    Object.keys(registry.resources.channels ?? {}),
  );

  for (const [alias, action] of Object.entries(registry.actions)) {
    if (
      action.id === SERVER_INVOKE_ACTION_ID ||
      !enabled(facade.expose.actions, action.id)
    ) continue;
    const path = canonicalActionPath(action.id);
    endpoints.push(endpoint({
      kind: "action",
      id: action.id,
      actionAlias: alias,
      method: "POST",
      path,
      inputSchema: cloneSchema(action.inputSchema),
      outputSchema: cloneSchema(action.outputSchema),
    }));
  }

  for (const [alias, collection] of Object.entries(registry.collections)) {
    const policy = facade.expose.collections;
    if (!enabled(policy, collection.name)) continue;
    const base = canonicalCollectionPath(collection.name);
    const add = (
      method: ServerHttpMethod,
      operation: string,
      suffix = "",
      inputSchema?: Readonly<Record<string, unknown>>,
      outputSchema?: Readonly<Record<string, unknown>>,
      member?: string,
    ) => {
      if (!operationEnabled(policy, operation)) return;
      endpoints.push(endpoint({
        kind: "collection",
        id: collection.name,
        collectionAlias: alias,
        method,
        path: `${base}${suffix}`,
        operation,
        ...(member ? { member } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        ...(outputSchema ? { outputSchema } : {}),
      }));
    };
    const schema = cloneSchema(collection.schema);
    add("GET", "list", "", undefined, schema);
    add("GET", "get", "/:id", undefined, schema);
    for (const [name, query] of Object.entries(collection.queries ?? {})) {
      const queryOutput = cloneSchema(query.outputSchema) ??
        (schema ? deepFreeze({ type: "array", items: schema }) : undefined);
      add(
        "POST",
        `query:${name}`,
        `/queries/${encodeURIComponent(name)}`,
        cloneSchema(query.inputSchema),
        queryOutput,
        name,
      );
    }
  }

  for (const alias of channelAliases) {
    if (!enabled(facade.expose.channels, alias)) continue;
    const base = canonicalChannelPath(alias);
    const observed =
      (registry.resources.channels[alias] as { egress?: string }).egress ===
        "request-observation";
    for (
      const method of (observed
        ? ["POST"]
        : ["GET", "POST"]) as readonly ServerHttpMethod[]
    ) {
      endpoints.push(endpoint({
        kind: "channel",
        id: alias,
        ...(observed ? { operation: "submit" } : {}),
        method,
        path: base,
      }));
    }
  }

  const httpIds = new Set<string>();
  for (const adapter of Object.values(registry.adapters.http ?? {})) {
    for (
      const route of (adapter as import("../http-adapter/index.ts").HttpAdapter)
        .routes
    ) {
      if (httpIds.has(route.id)) {
        throw new TypeError(`Duplicate HTTP endpoint ID: ${route.id}`);
      }
      httpIds.add(route.id);
      const action = route.action
        ? Object.entries(registry.actions).find(([, action]) =>
          action.id === route.action
        )
        : undefined;
      if (route.action && !action) {
        throw new TypeError(`HTTP Action '${route.action}' was not composed.`);
      }
      endpoints.push(
        endpoint({
          kind: "http",
          id: route.id,
          method: route.method,
          path: route.path,
          ...(action ? { actionAlias: action[0] } : {}),
          inputSchema: cloneSchema(
            route.inputSchema ??
              (route.action && !route.input
                ? action?.[1].inputSchema
                : undefined),
          ),
          metadata: cloneSchema(route.metadata),
          responseMediaType: route.responseMediaType,
          outputSchema: cloneSchema(
            route.outputSchema ?? action?.[1].outputSchema,
          ),
        }),
      );
    }
  }

  for (
    const [method, path, operation] of [
      ["GET", "/operations/:id", "get"],
      ["GET", "/operations/:id/result", "result"],
      ["DELETE", "/operations/:id", "cancel"],
      ["POST", "/operations/observe", "observe"],
    ] as const
  ) {
    endpoints.push(
      endpoint({
        kind: "operation",
        id: `operations.${operation}`,
        method,
        path,
        operation,
        ...(operation === "observe"
          ? {
            responseMediaType: "multipart/mixed",
            inputSchema: {
              type: "object",
              required: ["operationIds"],
              additionalProperties: false,
              properties: {
                operationIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 32,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
                checkpoint: { type: "string" },
              },
            },
          }
          : {}),
      }),
    );
  }

  endpoints.push(
    endpoint({
      kind: "asset",
      id: "assets",
      method: "POST",
      path: "/assets",
      operation: "upload",
    }),
    endpoint({
      kind: "asset",
      id: "assets",
      method: "GET",
      path: "/assets/:id",
    }),
    endpoint({ kind: "agents", id: "agents", method: "GET", path: "/agents" }),
    endpoint({
      kind: "openapi",
      id: "openapi",
      method: "GET",
      path: "/openapi.json",
    }),
  );

  const keys = new Set<string>();
  endpoints.sort((left, right) => {
    const a = pathSegments(left.path), b = pathSegments(right.path);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      const priority = Number(a[i].startsWith(":")) -
        Number(b[i].startsWith(":"));
      if (priority) return priority;
    }
    return left.key.localeCompare(right.key);
  });
  const routes = Object.freeze(endpoints.map((value) => {
    const segments = pathSegments(value.path);
    const collisionKey = `${value.method}:/${
      segments.map((segment) => segment.startsWith(":") ? ":" : segment).join(
        "/",
      )
    }`;
    if (keys.has(collisionKey)) {
      throw new TypeError(
        `Server route collision at '${value.method} ${value.path}'.`,
      );
    }
    keys.add(collisionKey);
    return Object.freeze({ endpoint: value, segments });
  }));
  const document = openApi(facade.basePath, routes);
  return Object.freeze({
    basePath: facade.basePath,
    routes,
    openApi: document,
    match(method, pathname) {
      const normalizedMethod = method.toUpperCase();
      const normalizedPath = pathname.replace(/\/+$/, "") || "/";
      if (
        normalizedPath !== facade.basePath &&
        !normalizedPath.startsWith(`${facade.basePath}/`)
      ) return null;
      const relative = normalizedPath.slice(facade.basePath.length) || "/";
      const candidate = relative.split("/").filter(Boolean).map((part) =>
        decodeURIComponent(part)
      );
      for (const route of routes) {
        if (route.endpoint.method !== normalizedMethod) continue;
        if (route.segments.length !== candidate.length) continue;
        const params: Record<string, string> = {};
        let matches = true;
        for (let index = 0; index < route.segments.length; index++) {
          const expected = route.segments[index];
          const actual = candidate[index];
          if (expected.startsWith(":")) params[expected.slice(1)] = actual;
          else if (expected !== actual) {
            matches = false;
            break;
          }
        }
        if (matches) {
          return Object.freeze({
            endpoint: route.endpoint,
            params: Object.freeze(params),
          });
        }
      }
      return null;
    },
  });
}
