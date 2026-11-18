/**
 * An update checked against its collection's schema before any store applies
 * it, as MongoDB's `$jsonSchema` validator does with `validationLevel:
 * "strict"`: what `$set` gives a field must fit the field's schema, and a field
 * the schema doesn't allow can't be set; `$unset` can't remove a required
 * field; `$inc` counts only numbers; `$push` and `$addToSet` add only items the
 * list's schema takes. Anything else that fails is refused the same way
 * (`invalid`, naming the field), before anything is written.
 *
 * Some of it can't be told from the update alone: a path through `anyOf`,
 * `$ref` and the like, a rule about the result (`minimum` after `$inc`,
 * `maxItems` after `$push`), or an object a nested `$set` may create, which has
 * rules of its own (`required`). The check then says it's unsure, and the
 * owner checks the documents the update leaves (see ops.ts). It's sure only
 * when a valid document can't be left invalid: PostgreSQL's single-statement
 * path, which never sees the documents, takes only those updates, so it stays
 * fast for plain `$set` and counters.
 */
import { Validator } from "@cfworker/json-schema";
import { schemaFailure } from "./registry.ts";

type Schema = Record<string, unknown> | boolean | undefined;

/** Keywords that say only what something is, not what it must be: nothing to check about a result. */
const ABOUT = new Set([
  "type",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** What an object may say and still take a field set inside it without a check of the whole. */
const PLAIN_OBJECT = new Set([...ABOUT, "properties", "additionalProperties"]);

/** What a collection's schema may say and still have its updates checked here in full. */
const PLAIN_ROOT = new Set([...PLAIN_OBJECT, "required", "$schema", "$id", "$defs"]);

/** Keywords whose effect on a path can't be resolved here. */
const UNSURE = ["$ref", "$dynamicRef", "anyOf", "oneOf", "allOf", "not", "if", "dependentSchemas"];

const unsure = (schema: Schema) =>
  typeof schema === "object" && UNSURE.some((key) => key in schema);

/**
 * What a path's schema is: one (`true` when anything goes), and whether every
 * object on the way is plain (setting inside it can't break a rule of its
 * own); refused; or not to be told here.
 */
type Found = { schema: Schema; plain: boolean } | { refused: true } | { unsure: true };
type Step = { schema: Schema } | { refused: true } | { unsure: true };

function step(schema: Schema, key: string): Step {
  if (schema === undefined || schema === true) return { schema: true };
  if (schema === false) return { refused: true };
  if (unsure(schema) || "unevaluatedProperties" in schema || "unevaluatedItems" in schema) {
    return { unsure: true };
  }
  const types = [schema.type].flat().filter(Boolean) as string[];
  if (/^\d+$/.test(key) && (types.includes("array") || "items" in schema)) {
    const prefix = schema.prefixItems as Schema[] | undefined;
    return { schema: prefix?.[Number(key)] ?? (schema.items as Schema) ?? true };
  }
  if (types.length && !types.includes("object")) return { unsure: true };
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (properties && Object.hasOwn(properties, key)) return { schema: properties[key] };
  // A key some pattern names may take more than one schema: left to the result's check.
  const patterns = Object.keys((schema.patternProperties ?? {}) as Record<string, Schema>);
  if (patterns.some((pattern) => new RegExp(pattern, "u").test(key))) return { unsure: true };
  const extra = schema.additionalProperties as Schema;
  if (extra === false) return { refused: true };
  return { schema: extra ?? true };
}

/** The schema at a dot path, from the collection's. */
function find(root: Schema, path: string): Found {
  const keys = path.split(".");
  let at: Schema = root;
  let plain = true;
  for (const [i, key] of keys.entries()) {
    // Objects on the way (not the collection's own): setting inside one may create it.
    if (i > 0 && typeof at === "object" && Object.keys(at).some((k) => !PLAIN_OBJECT.has(k))) {
      plain = false;
    }
    const next = step(at, key);
    if (!("schema" in next)) return next;
    at = next.schema;
  }
  return { schema: at, plain };
}

/** Whether a schema says more than what something is: a rule a result must keep to. */
const rules = (schema: Schema) =>
  typeof schema === "object" && Object.keys(schema).some((key) => !ABOUT.has(key));

const typesOf = (schema: Schema): string[] =>
  typeof schema === "object" ? [schema.type].flat().filter(Boolean) as string[] : [];

/**
 * A collection's update check: refuses (`invalid`) what can't fit, and says
 * whether it's sure the update leaves valid documents (`true`), or the
 * documents it leaves must be checked (`false`).
 */
export function updateCheck(
  schema: unknown,
  label: string,
  vectors: string[] = [],
): (update: Record<string, unknown>) => boolean {
  const checks = new WeakMap<object, (value: unknown) => string | undefined>();
  const fits = (at: Schema, value: unknown): string | undefined => {
    if (at === undefined || at === true) return undefined;
    if (at === false) return "not allowed";
    let check = checks.get(at);
    if (!check) {
      const validator = new Validator(at as never, "2020-12", false);
      check = (value) => {
        const result = validator.validate(value);
        return result.valid ? undefined : result.errors.at(-1)?.error ?? "invalid";
      };
      checks.set(at, check);
    }
    return check(value);
  };
  const refuse = (path: string, why: string) => {
    throw schemaFailure(label, why, `#/${path.replaceAll(".", "/")}`);
  };
  const required = (parent: Schema, key: string) =>
    typeof parent === "object" && Array.isArray(parent.required) && parent.required.includes(key);

  // A rule about the whole document (`minProperties`, `dependentRequired`…): no update is sure.
  const root = schema as Schema;
  const plainRoot = typeof root !== "object" || Object.keys(root).every((k) => PLAIN_ROOT.has(k));

  return (update) => {
    let sure = plainRoot;
    // Vector fields are kept apart from documents, and checked as vectors (ops.ts).
    const each = (operator: string) =>
      Object.entries((update[operator] ?? {}) as Record<string, unknown>)
        .filter(([path]) => !vectors.includes(path));
    for (const [path, value] of each("$set")) {
      const found = find(root, path);
      if ("refused" in found) refuse(path, `"${path}" isn't a field this collection has`);
      else if ("unsure" in found) sure = false;
      else {
        const why = fits(found.schema, value);
        if (why) refuse(path, why);
        if (!found.plain) sure = false;
      }
    }
    for (const [path] of each("$unset")) {
      const keys = path.split(".");
      const parent = keys.length > 1
        ? find(root, keys.slice(0, -1).join("."))
        : { schema: root, plain: true };
      if (!("schema" in parent)) sure = false;
      else {
        if (required(parent.schema, keys.at(-1)!)) {
          refuse(path, `"${keys.at(-1)}" is required: it can't be unset`);
        }
        const object = parent.schema;
        if (
          !parent.plain || (keys.length > 1 && typeof object === "object" &&
            Object.keys(object).some((k) => !PLAIN_OBJECT.has(k) && k !== "required"))
        ) sure = false;
      }
    }
    for (const [path, by] of each("$inc")) {
      if (typeof by !== "number" || !Number.isFinite(by)) refuse(path, "$inc takes a number");
      const found = find(root, path);
      if ("refused" in found) refuse(path, `"${path}" isn't a field this collection has`);
      else if ("unsure" in found) sure = false;
      else {
        const types = typesOf(found.schema);
        if (types.length && !types.includes("number") && !types.includes("integer")) {
          refuse(path, `$inc counts numbers, and "${path}" isn't one`);
        }
        if (types.includes("integer") && !types.includes("number") && !Number.isInteger(by)) {
          refuse(path, `"${path}" is an integer: $inc it by one`);
        }
        if (rules(found.schema) || !found.plain) sure = false;
      }
    }
    for (const operator of ["$push", "$addToSet"]) {
      for (const [path, value] of each(operator)) {
        const found = find(root, path);
        if ("refused" in found) refuse(path, `"${path}" isn't a field this collection has`);
        else if ("unsure" in found) sure = false;
        else {
          const list = found.schema;
          const types = typesOf(list);
          if (types.length && !types.includes("array")) {
            refuse(path, `${operator} adds to a list, and "${path}" isn't one`);
          }
          const items = typeof list === "object" ? list.items as Schema : undefined;
          for (const item of itemsOf(value)) {
            const why = fits(items, item);
            if (why) refuse(path, why);
          }
          // What a list must keep to as a whole, besides its type and items.
          if (
            !found.plain || typeof list === "object" &&
              Object.keys(list).some((key) => !ABOUT.has(key) && key !== "items")
          ) sure = false;
        }
      }
    }
    for (const [path] of each("$pull")) {
      const found = find(root, path);
      if (!("schema" in found) || rules(found.schema)) sure = false;
    }
    return sure;
  };
}

/** What `$push` or `$addToSet` adds: one value, or `$each`'s. */
export function itemsOf(value: unknown): unknown[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.hasOwn(value, "$each")
    ? (value as { $each: unknown[] }).$each
    : [value];
}

/** What's wrong with a document, by where and which rule: none when it's valid. */
export type Problem = { at: string; rule: string; error: string };

/** A collection's list of what's wrong with a document. */
export function problemsOf(schema: unknown): (doc: unknown) => Problem[] {
  const validator = new Validator(schema as never, "2020-12", false);
  return (doc) =>
    validator.validate(doc).errors.map((e) => ({
      at: e.instanceLocation,
      rule: e.keyword,
      error: e.error,
    }));
}
