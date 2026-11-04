/**
 * OpenAPI schemas as the JSON Schema (2020-12) a tool's input is: local
 * `$ref`s inlined (one that recurses kept as a permissive schema), 3.0's
 * `nullable`, boolean `exclusiveMinimum`/`exclusiveMaximum` and `example`
 * converted, `readOnly` properties dropped (a request doesn't send them), and
 * what isn't JSON Schema (`discriminator`, `xml`, `x-…`) left out. Enums,
 * formats, defaults and descriptions stay.
 */
import { type Json, pointer } from "./spec.ts";

/** Keywords that aren't JSON Schema, or that inputs don't need. */
const DROPPED = new Set(["nullable", "discriminator", "xml", "externalDocs", "example"]);
/** Keywords holding one schema, a list of them, or a map of them. */
const ONE = ["items", "not", "if", "then", "else", "contains", "propertyNames"];
const LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];
const MAP = ["patternProperties", "$defs", "dependentSchemas"];

/** A schema, converted. `stack` is the `$ref`s being inlined, to stop where one recurses. */
export function convert(doc: Json, schema: unknown, stack: string[] = []): Json {
  if (schema === true || schema === undefined) return {};
  if (schema === false) return { not: {} };
  if (!schema || typeof schema !== "object") return {};
  const given = schema as Json;
  if (typeof given.$ref === "string") {
    const ref = given.$ref;
    const target = pointer(doc, ref) as Json;
    const { $ref: _, ...siblings } = given;
    // A schema that contains itself (a tree): its inner self takes anything of its type.
    if (stack.includes(ref)) {
      return {
        ...(typeof target?.type === "string" ? { type: target.type } : {}),
        ...(typeof target?.description === "string" ? { description: target.description } : {}),
      };
    }
    return convert(doc, { ...target, ...siblings }, [...stack, ref]);
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(given)) {
    if (DROPPED.has(key) || key.startsWith("x-")) continue;
    if (key === "properties") {
      const properties: Json = {};
      for (const [name, child] of Object.entries(value as Json)) {
        const converted = convert(doc, child, stack);
        if (converted.readOnly !== true) properties[name] = converted;
      }
      out.properties = properties;
    } else if (key === "additionalProperties" && typeof value === "object") {
      out.additionalProperties = convert(doc, value, stack);
    } else if (ONE.includes(key)) out[key] = convert(doc, value, stack);
    else if (LIST.includes(key) && Array.isArray(value)) {
      out[key] = value.map((v) => convert(doc, v, stack));
    } else if (MAP.includes(key) && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([k, v]) => [k, convert(doc, v, stack)]),
      );
    } else out[key] = value;
  }
  // Required properties that were read-only aren't asked for.
  if (Array.isArray(out.required) && out.properties) {
    const kept = (out.required as string[]).filter((name) =>
      name in (out.properties as Json) || !(given.properties as Json)?.[name]
    );
    if (kept.length) out.required = kept;
    else delete out.required;
  }
  if (given.example !== undefined && out.examples === undefined) out.examples = [given.example];
  // 3.0: a boolean beside `minimum`/`maximum`.
  for (const [flag, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof out[flag] !== "boolean") continue;
    if (out[flag] && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    } else delete out[flag];
  }
  if (given.nullable === true) return nullable(out);
  return out;
}

/** 3.0's `nullable: true`: null as well. */
function nullable(schema: Json): Json {
  if (typeof schema.type === "string" || Array.isArray(schema.type)) {
    const types = [schema.type].flat() as string[];
    const out: Json = { ...schema, type: types.includes("null") ? types : [...types, "null"] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      out.enum = [...schema.enum, null];
    }
    return out;
  }
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * An object schema's properties, to take as a tool's top-level input: a plain
 * object, or `allOf` parts that all are. Undefined for anything else.
 */
export function objectOf(
  schema: Json,
): { properties: Json; required: string[]; additional?: unknown } | undefined {
  if (Array.isArray(schema.allOf) && !schema.properties && !schema.anyOf && !schema.oneOf) {
    const parts = (schema.allOf as Json[]).map(objectOf);
    if (parts.some((p) => !p)) return undefined;
    return {
      properties: Object.assign({}, ...parts.map((p) => p!.properties)),
      required: [...new Set(parts.flatMap((p) => p!.required))],
      ...(parts.some((p) => p!.additional === false) ? { additional: false } : {}),
    };
  }
  const types = [schema.type ?? (schema.properties ? "object" : undefined)].flat();
  if (!types.includes("object") || schema.anyOf || schema.oneOf || !schema.properties) {
    return undefined;
  }
  return {
    properties: schema.properties as Json,
    required: (schema.required ?? []) as string[],
    ...(schema.additionalProperties !== undefined
      ? { additional: schema.additionalProperties }
      : {}),
  };
}
