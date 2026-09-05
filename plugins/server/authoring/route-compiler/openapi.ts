/** OpenAPI projection of the compiled route contract. @module */
import type { CompiledServerRoute } from "./index.ts";
const SECRET_DISCLOSURE_KEYWORDS = new Set([
  "default",
  "const",
  "enum",
  "examples",
  "example",
]);

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
  if (
    endpoint.kind === "action" || endpoint.actionAlias ||
    endpoint.kind === "channel" && endpoint.operation === "submit"
  ) {
    return jsonEnvelope({
      type: "object",
      required: ["operationId", "correlationId", "status", "acceptedAt"],
      properties: {
        operationId: { type: "string" },
        correlationId: { type: "string" },
        status: { type: "string" },
        acceptedAt: { type: "string", format: "date-time" },
        checkpoint: { type: "string" },
      },
    });
  }
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
  const successStatus = value.kind === "action" || value.actionAlias ||
      value.kind === "channel" && value.operation === "submit"
    ? "202"
    : (value.kind === "collection" &&
        value.operation === "create") ||
        (value.kind === "asset" && value.operation === "upload")
    ? "201"
    : noContent
    ? "204"
    : "200";
  const mediaType = value.responseMediaType ??
    (value.kind === "asset" && value.method === "GET"
      ? "application/octet-stream"
      : "application/json");
  const content = noContent ? undefined : {
    [mediaType]: {
      schema: mediaType === "application/json"
        ? responseSchema(route)
        : { type: "string", format: "binary" },
    },
  };
  const parameters = route.segments.filter((segment) => segment.startsWith(":"))
    .map((segment) => ({
      name: segment.slice(1),
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
  const headers = value.kind === "action" || value.actionAlias ||
      value.kind === "channel" && value.operation === "submit"
    ? [{
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1 },
    }]
    : value.kind === "asset" && value.operation === "upload"
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
    ...((value.kind === "action" || value.actionAlias ||
        value.kind === "channel" && value.operation === "submit") &&
        value.outputSchema
      ? { "x-copilotz-result-schema": value.outputSchema }
      : {}),
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

export function openApi(
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
    info: { title: "Copilotz Server", version: "0.66.0" },
    paths,
  }) as Record<string, unknown>);
}
