/**
 * An operation as a tool takes it: one input object, merging its path,
 * query, header and cookie parameters with its JSON body (an object body's
 * properties side by side with them; any other body as `body`), and the plan
 * that puts each input back where the request wants it. Two inputs of one
 * name can't be told apart in one object, so they fail.
 */
import { convert, objectOf } from "./schema.ts";
import { deref, type Found, type Json, type Parameter, type RequestBody } from "./spec.ts";

/** Where an input goes, and how it's written there (OpenAPI's `style` and `explode`). */
export type Param = {
  name: string;
  in: Parameter["in"];
  style: string;
  explode: boolean;
  /** Sent as JSON (a parameter with `content` rather than `schema`). */
  json?: boolean;
};

/** Its body: a media type, and either the inputs that are its properties, or the `body` input. */
export type Body = {
  type: string;
  required: boolean;
  /** An object body's properties, taken from the input; none: the whole `body` input. */
  keys?: string[];
  /** Inputs no parameter names go in the body too (it takes more properties). */
  extra?: boolean;
};

export type Plan = {
  id: string;
  method: string;
  path: string;
  params: Param[];
  body?: Body;
};

/** Methods whose requests carry a body. */
const BODIED = new Set(["post", "put", "patch", "delete"]);

const STYLES: Record<Parameter["in"], string> = {
  path: "simple",
  query: "form",
  header: "simple",
  cookie: "form",
};

/** A body's JSON media type and its schema: a JSON type, else any type at all, sent as JSON. */
function jsonOf(content: Record<string, { schema?: unknown }> = {}) {
  const entries = Object.entries(content);
  const json = entries.find(([type]) => /^application\/(.+\+)?json\b/i.test(type));
  if (json) return json;
  const any = entries.find(([type]) => type === "*/*" || type === "application/*");
  return any && ["application/json", any[1]] as const;
}

/** The operation's tool input and plan, or why it can't be one. */
export function planOf(
  doc: Json,
  found: Found,
): { input: Json; plan: Plan; description: string } | { skip: string } {
  const { id, method, path, operation } = found;
  const where = `operation "${id}" (${method.toUpperCase()} ${path})`;
  const properties: Json = {};
  const required: string[] = [];
  const from = new Map<string, string>();
  const add = (name: string, schema: Json, what: string) => {
    if (from.has(name)) {
      throw new Error(
        `${where} has two inputs named "${name}" (${from.get(name)} and ${what}): a tool's ` +
          "input is one object, so leave the operation out (`operations`) or rename one in the spec",
      );
    }
    from.set(name, what);
    properties[name] = schema;
  };

  const params: Param[] = [];
  for (const p of found.parameters) {
    const media = p.content ? Object.values(p.content)[0] : undefined;
    const schema = convert(doc, p.schema ?? media?.schema);
    if (p.description) schema.description = p.description;
    if (p.deprecated) schema.deprecated = true;
    if (p.example !== undefined && schema.examples === undefined) schema.examples = [p.example];
    add(p.name, schema, `${p.in} parameter`);
    if (p.required || p.in === "path") required.push(p.name);
    const style = p.style ?? STYLES[p.in];
    params.push({
      name: p.name,
      in: p.in,
      style,
      explode: p.explode ?? style === "form",
      ...(p.content ? { json: true } : {}),
    });
  }

  let body: Body | undefined;
  let additional: unknown;
  const given = operation.requestBody && BODIED.has(method)
    ? deref<RequestBody>(doc, operation.requestBody)
    : undefined;
  if (given) {
    const media = jsonOf(given.content);
    if (!media) {
      const types = Object.keys(given.content ?? {}).join(", ") || "none";
      if (given.required) return { skip: `its body isn't JSON (${types})` };
    } else {
      const schema = convert(doc, media[1].schema);
      const object = objectOf(schema);
      const needed = given.required === true;
      if (object && Object.keys(object.properties).length) {
        for (const [name, child] of Object.entries(object.properties)) {
          add(name, child as Json, "body property");
        }
        // Asked for even when the spec forgets to say the body is required: sending them is safe.
        required.push(...object.required.filter((name) => name in object.properties));
        additional = object.additional;
        body = {
          type: media[0],
          required: needed,
          keys: Object.keys(object.properties),
          ...(object.additional !== false ? { extra: true } : {}),
        };
      } else {
        if (given.description && !schema.description) schema.description = given.description;
        add("body", schema, "the body");
        if (needed) required.push("body");
        body = { type: media[0], required: needed };
      }
    }
  }

  const input: Json = {
    type: "object",
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
    ...(additional === false ? { additionalProperties: false } : {}),
  };
  const words = [operation.summary, operation.description]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  // A description that only repeats its summary says it once.
  if (words.length === 2 && words[1].startsWith(words[0])) words.shift();
  const description = words.join("\n\n") || `${method.toUpperCase()} ${path}`;
  return {
    input,
    plan: { id, method: method.toUpperCase(), path, params, ...(body ? { body } : {}) },
    description,
  };
}
