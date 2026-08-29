/** Compiles composed primitives into one immutable Server route table. @module */

import type { PluginRegistry } from "@copilotz/copilotz/plugins";
import { SERVER_INVOKE_ACTION_ID } from "../../actions/invoke-action/index.ts";
import type {
  ServerCollectionExposure,
  ServerEndpointDescriptor,
  ServerFacadeResource,
  ServerHttpMethod,
  ServerPatternPolicy,
  ServerRouteOverride,
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

const CHANNEL_METHODS = Object.freeze(
  [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ] as const,
);

const SECRET_DISCLOSURE_KEYWORDS = new Set([
  "default",
  "const",
  "enum",
  "examples",
  "example",
]);

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

function overridePath(
  override: ServerRouteOverride | undefined,
  fallback: string,
): string | null {
  return override === false ? null : override?.path ?? fallback;
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

function jsonEnvelope(
  data: Readonly<Record<string, unknown>>,
  pageInfo = false,
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: {
      data,
      ...(pageInfo
        ? {
          pageInfo: {
            type: "object",
            properties: {
              next: { type: "string" },
              hasMore: { type: "boolean" },
            },
            required: ["hasMore"],
          },
        }
        : {}),
    },
    required: pageInfo ? ["data", "pageInfo"] : ["data"],
  };
}

function responseSchema(
  route: CompiledServerRoute,
): Readonly<Record<string, unknown>> {
  const endpoint = route.endpoint;
  if (endpoint.kind === "asset" && endpoint.operation === "upload") {
    return jsonEnvelope({
      type: "object",
      properties: {
        asset: { type: "object" },
        assetRef: { type: "string" },
        content: {
          type: "object",
          properties: {
            assetId: { type: "string" },
            kind: { const: "file" },
            role: { const: "attachment" },
            mediaType: { type: "string" },
            disposition: { const: "attachment" },
            name: { type: "string" },
          },
          required: ["assetId", "kind", "role", "mediaType", "disposition"],
        },
      },
      required: ["asset", "assetRef", "content"],
    });
  }
  if (endpoint.kind === "agents") {
    return jsonEnvelope({ type: "array", items: {} });
  }
  if (endpoint.kind !== "collection") {
    return jsonEnvelope(endpoint.outputSchema ?? {});
  }
  if (endpoint.operation === "list") {
    return jsonEnvelope({
      type: "array",
      items: endpoint.outputSchema ?? {},
    }, true);
  }
  if (endpoint.operation?.startsWith("query:")) {
    return jsonEnvelope(
      endpoint.outputSchema ?? {
        type: "array",
        items: {},
      },
    );
  }
  return jsonEnvelope(endpoint.outputSchema ?? {});
}

/** Copies an OpenAPI value while removing values disclosed by a secret schema. */
function projectOpenApiSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectOpenApiSecrets);
  if (!value || typeof value !== "object") return value;

  const schema = value as Record<string, unknown>;
  const secret = schema["x-copilotz-secret"] === true;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !secret || !SECRET_DISCLOSURE_KEYWORDS.has(key))
      .map(([key, nested]) => [key, projectOpenApiSecrets(nested)]),
  );
}

function operationObject(route: CompiledServerRoute): Record<string, unknown> {
  const value = route.endpoint;
  const operationId = value.kind === "collection"
    ? `${value.id}.${value.operation}`
    : value.kind === "channel"
    ? `${value.id}.${value.method.toLowerCase()}`
    : value.kind === "asset" && value.operation
    ? `${value.id}.${value.operation}`
    : value.id;
  const requestBody = value.kind === "asset" && value.operation === "upload"
    ? {
      required: true,
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    }
    : value.inputSchema &&
        value.method !== "GET" && value.method !== "DELETE"
    ? {
      required: true,
      content: {
        "application/json": { schema: value.inputSchema },
      },
    }
    : undefined;
  const noContent = value.kind === "collection" &&
    value.operation === "delete";
  const successStatus = (value.kind === "collection" &&
      value.operation === "create") ||
      (value.kind === "asset" && value.operation === "upload")
    ? "201"
    : noContent
    ? "204"
    : "200";
  const content = noContent ? undefined : {
    "application/json": { schema: responseSchema(route) },
    ...(value.kind === "action" || value.kind === "channel"
      ? {
        "text/event-stream": {
          schema: { type: "string", contentMediaType: "text/event-stream" },
        },
        "multipart/mixed": {
          schema: { type: "string", contentMediaType: "multipart/mixed" },
        },
      }
      : {}),
  };
  const parameters = route.segments.filter((segment) => segment.startsWith(":"))
    .map((segment) => ({
      name: segment.slice(1),
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
  const headers = value.kind === "asset" && value.operation === "upload"
    ? [{
      name: "Idempotency-Key",
      in: "header",
      required: false,
      schema: { type: "string" },
    }, {
      name: "Content-Disposition",
      in: "header",
      required: false,
      schema: { type: "string" },
    }]
    : [];
  return {
    operationId,
    tags: [value.kind],
    ...(parameters.length || headers.length
      ? { parameters: [...parameters, ...headers] }
      : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      [successStatus]: {
        description: "Successful response",
        ...(content ? { content } : {}),
      },
    },
  };
}

function openApi(
  basePath: string,
  routes: readonly CompiledServerRoute[],
): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (route.endpoint.kind === "openapi") continue;
    const path = `${basePath}${route.endpoint.path}`.replace(
      /:([A-Za-z0-9_]+)/g,
      "{$1}",
    );
    const item = paths[path] ?? {};
    item[route.endpoint.method.toLowerCase()] = operationObject(route);
    paths[path] = item;
  }
  return deepFreeze(projectOpenApiSecrets({
    openapi: "3.2.0",
    info: { title: "Copilotz Server", version: "1.0.0" },
    paths,
  }) as Record<string, unknown>);
}

function ensureOverrideTargets(
  overrides: Readonly<Record<string, ServerRouteOverride>>,
  available: ReadonlySet<string>,
  kind: string,
): void {
  for (const id of Object.keys(overrides)) {
    if (!available.has(id)) {
      throw new TypeError(
        `Server ${kind} override target '${id}' was not found.`,
      );
    }
  }
}

/** Compiles one complete registry into deterministic routes and OpenAPI. */
export function compileServerRoutes(
  registry: PluginRegistry,
  facade: ServerFacadeResource,
): CompiledServerRoutes {
  const endpoints: ServerEndpointDescriptor[] = [];
  const actionIds = new Set(
    Object.values(registry.actions).map((action) => action.id),
  );
  const collectionNames = new Set(
    Object.values(registry.collections).map((collection) => collection.name),
  );
  const channelAliases = new Set(
    Object.keys(registry.resources.channels ?? {}),
  );
  ensureOverrideTargets(facade.overrides.actions, actionIds, "Action");
  ensureOverrideTargets(
    facade.overrides.collections,
    collectionNames,
    "Collection",
  );
  ensureOverrideTargets(facade.overrides.channels, channelAliases, "Channel");

  for (const [alias, action] of Object.entries(registry.actions)) {
    if (
      action.id === SERVER_INVOKE_ACTION_ID ||
      !enabled(facade.expose.actions, action.id)
    ) continue;
    const path = overridePath(
      facade.overrides.actions[action.id],
      canonicalActionPath(action.id),
    );
    if (!path) continue;
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
    const base = overridePath(
      facade.overrides.collections[collection.name],
      canonicalCollectionPath(collection.name),
    );
    if (!base) continue;
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
    add("POST", "create", "", schema, schema);
    add("GET", "get", "/:id", undefined, schema);
    add("PATCH", "update", "/:id", schema, schema);
    add("DELETE", "delete", "/:id");
    for (const [name, query] of Object.entries(collection.queries ?? {})) {
      const queryOutput = cloneSchema(query.outputSchema) ??
        (schema ? deepFreeze({ type: "array", items: schema }) : undefined);
      add(
        "QUERY",
        `query:${name}`,
        `/queries/${encodeURIComponent(name)}`,
        cloneSchema(query.inputSchema),
        queryOutput,
        name,
      );
    }
    for (const [name, command] of Object.entries(collection.commands ?? {})) {
      add(
        "POST",
        `command:${name}`,
        `/:id/commands/${encodeURIComponent(name)}`,
        cloneSchema(command.input),
        schema,
        name,
      );
    }
  }

  for (const alias of channelAliases) {
    if (!enabled(facade.expose.channels, alias)) continue;
    const base = overridePath(
      facade.overrides.channels[alias],
      canonicalChannelPath(alias),
    );
    if (!base) continue;
    for (const method of CHANNEL_METHODS) {
      endpoints.push(endpoint({
        kind: "channel",
        id: alias,
        method,
        path: base,
      }));
    }
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
