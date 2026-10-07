import type { CollectionDefinition } from "./definition.ts";

/** One schema-derived SQL expression shared by ordering and physical indexes. */
export type CollectionField = Readonly<{
  expression: string;
  cast: "text" | "numeric" | "boolean" | "timestamptz";
}>;

export function collectionJsonField(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) {
    throw new TypeError(`Invalid collection field '${field}'.`);
  }
  const parts = field.split(".");
  return parts.length === 1
    ? `data -> '${parts[0]}'`
    : `data #> '{${parts.join(",")}}'`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Reject undeclared paths before generating either scalar or JSON index SQL. */
export function declaredCollectionJsonField(
  definition: CollectionDefinition,
  field: string,
): string {
  const expression = collectionJsonField(field);
  let schema: unknown = definition.schema;
  for (const part of field.split(".")) {
    const properties = object(object(schema).properties);
    if (!Object.hasOwn(properties, part)) {
      throw new TypeError(
        `Collection '${definition.name}' has no declared field '${field}'.`,
      );
    }
    schema = properties[part];
  }
  return expression;
}

export function collectionField(
  definition: CollectionDefinition,
  field: string,
): CollectionField {
  const columns: Record<string, CollectionField> = {
    id: { expression: "id", cast: "text" },
    namespace: { expression: "namespace", cast: "text" },
    createdAt: { expression: "created_at", cast: "timestamptz" },
    updatedAt: { expression: "updated_at", cast: "timestamptz" },
  };
  if (Object.hasOwn(columns, field)) return columns[field];
  const json = collectionJsonField(field);
  let schema: unknown = definition.schema;
  for (const part of field.split(".")) {
    schema = object(object(schema).properties)[part];
  }
  const fieldSchema = object(schema);
  const declared = fieldSchema.type ??
    (Array.isArray(fieldSchema.enum)
      ? fieldSchema.enum.map((value) => value === null ? "null" : typeof value)
      : Object.hasOwn(fieldSchema, "const")
      ? [fieldSchema.const === null ? "null" : typeof fieldSchema.const]
      : undefined);
  const types = new Set(
    (Array.isArray(declared) ? declared : [declared])
      .filter((type) => type !== "null")
      .map((type) => type === "integer" ? "number" : type),
  );
  const type = [...types][0];
  if (
    types.size !== 1 ||
    !["string", "number", "boolean"].includes(type as string)
  ) {
    throw new TypeError(
      `Collection '${definition.name}' field '${field}' must declare one scalar type (optionally nullable) for ordering or a scalar index.`,
    );
  }
  const text = json.replace("->", "->>").replace("#>", "#>>");
  if (type === "string") return { expression: text, cast: "text" };
  const cast = type === "number" ? "numeric" : "boolean";
  // nodes is shared by all Collections. A guarded cast is safe even when the
  // planner evaluates it on a different Collection or on old malformed data.
  return {
    expression:
      `CASE WHEN jsonb_typeof(${json}) = '${type}' THEN (${text})::${cast} ELSE NULL::${cast} END`,
    cast,
  };
}
