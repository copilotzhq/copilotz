/**
 * An OpenAPI document: read (an object, or JSON text), its local `$ref`s
 * followed, and its operations listed with their parameters merged (a path's
 * own, then the operation's, which win) and an id each.
 */
export type Json = Record<string, unknown>;

export type Parameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: unknown;
  content?: Record<string, { schema?: unknown }>;
  style?: string;
  explode?: boolean;
  example?: unknown;
};

export type RequestBody = {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: unknown }>;
};

export type OperationObject = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
};

/** An operation found in the document: its id, method, path and parameters. */
export type Found = {
  id: string;
  method: string;
  path: string;
  operation: OperationObject;
  parameters: Parameter[];
};

export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** The document, as an object: OpenAPI 3 only. */
export function read(spec: Json | string): Json {
  let doc: unknown = spec;
  if (typeof spec === "string") {
    try {
      doc = JSON.parse(spec);
    } catch {
      throw new Error("The OpenAPI spec isn't JSON: pass an object (parse YAML first)");
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("The OpenAPI spec must be an object");
  }
  const version = (doc as Json).openapi;
  if (typeof version !== "string" || !version.startsWith("3.")) {
    throw new Error(
      (doc as Json).swagger
        ? "Swagger 2.0 isn't supported: convert the spec to OpenAPI 3 first"
        : "Not an OpenAPI 3 document (no `openapi: 3.x`)",
    );
  }
  return doc as Json;
}

/** What a local `$ref` (`#/components/schemas/Trip`) points to. */
export function pointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith("#")) {
    throw new Error(`Only local $refs are supported, not "${ref}"`);
  }
  let at: unknown = doc;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    at = at && typeof at === "object" ? (at as Json)[key] : undefined;
  }
  if (at === undefined) throw new Error(`Nothing at $ref "${ref}"`);
  return at;
}

/** An object that may be a `$ref` (a parameter, a request body), followed to what it is. */
export function deref<T>(doc: Json, value: unknown): T {
  const seen = new Set<string>();
  while (value && typeof value === "object" && typeof (value as Json).$ref === "string") {
    const ref = (value as Json).$ref as string;
    if (seen.has(ref)) throw new Error(`$ref "${ref}" refers to itself`);
    seen.add(ref);
    value = pointer(doc, ref);
  }
  return value as T;
}

/** An id usable in an Action's and a tool's name: letters, digits and `_`. */
export const idOf = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_{2,}/g, "_").replace(/^_|_$/g, "") || "operation";

/** The document's operations, each with an id (its `operationId`, or its method and path). */
export function operationsOf(doc: Json): Found[] {
  const found: Found[] = [];
  const ids = new Map<string, string>();
  for (const [path, raw] of Object.entries((doc.paths ?? {}) as Json)) {
    const item = deref<Json>(doc, raw);
    for (const method of METHODS) {
      const operation = item[method] as OperationObject | undefined;
      if (!operation) continue;
      const id = idOf(operation.operationId ?? `${method}_${path}`);
      const where = `${method.toUpperCase()} ${path}`;
      if (ids.has(id)) {
        throw new Error(`Two operations have the id "${id}": ${ids.get(id)} and ${where}`);
      }
      ids.set(id, where);
      found.push({ id, method, path, operation, parameters: parametersOf(doc, item, operation) });
    }
  }
  return found;
}

/**
 * Its parameters: the path's, then the operation's, which replace one of the
 * same name and place. Accept, Content-Type and Authorization headers aren't
 * parameters (the spec says so: the request sets them).
 */
function parametersOf(doc: Json, item: Json, operation: OperationObject): Parameter[] {
  const all = new Map<string, Parameter>();
  for (const raw of [...(item.parameters as unknown[] ?? []), ...(operation.parameters ?? [])]) {
    const p = deref<Parameter>(doc, raw);
    if (!p?.name || !p.in) continue;
    if (p.in === "header" && /^(accept|content-type|authorization)$/i.test(p.name)) continue;
    all.set(`${p.in}:${p.name}`, p);
  }
  return [...all.values()];
}

/** The base URL its first server gives (its variables at their defaults), or none. */
export function serverOf(doc: Json): string | undefined {
  const [server] = (doc.servers ?? []) as { url?: string; variables?: Record<string, Json> }[];
  if (!server?.url) return undefined;
  return server.url.replace(/\{([^}]+)\}/g, (all, name) => {
    const value = server.variables?.[name]?.default;
    return value === undefined ? all : String(value);
  });
}
