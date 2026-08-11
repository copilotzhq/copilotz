import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type { FromSchema } from "../../dependencies/json-schema-to-ts.ts";

export type CollectionIndex =
  | string
  | readonly string[]
  | Readonly<{
    fields: string | readonly string[];
    unique?: boolean;
    type?: "btree" | "gin" | "gist" | "brin";
    where?: Readonly<Record<string, unknown>>;
  }>;

export type CollectionRelation = Readonly<{
  type: "hasOne" | "hasMany" | "belongsTo";
  collection: string;
  foreignKey: string;
  edgeType?: string;
}>;

export type CollectionHookContext = Readonly<{
  namespace: string;
  userId?: string;
}>;

export type CollectionBeforeHooks = Readonly<{
  beforeCreate?: (
    data: Record<string, unknown>,
    context: CollectionHookContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  beforeUpdate?: (
    data: Record<string, unknown>,
    context: CollectionHookContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  beforeDelete?: (
    filter: Record<string, unknown>,
    context: CollectionHookContext,
  ) => void | Promise<void>;
}>;

export type CollectionDefinition<
  S extends JsonSchema = JsonSchema,
  TSelect = S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  TInsert = S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
    : Record<string, unknown>,
> = Readonly<{
  name: string;
  schema: S;
  keys?: readonly Readonly<{ property: string }>[];
  timestamps?: Readonly<{
    createdAt?: string;
    updatedAt?: string;
  }>;
  defaults?: Readonly<Record<string, (() => unknown) | unknown>>;
  indexes?: readonly CollectionIndex[];
  relations?: Readonly<Record<string, CollectionRelation>>;
  search?: Readonly<{
    enabled: boolean;
    fields: readonly string[];
  }>;
  /** Fields whose values are canonical ContentRef sequences. */
  content?: Readonly<{ fields: readonly string[] }>;
  /** Post-write behavior belongs in named event processors. */
  hooks?: CollectionBeforeHooks;
  readonly $inferSelect: TSelect;
  readonly $inferInsert: TInsert;
}>;

export type CollectionDefinitionInput<S extends JsonSchema = JsonSchema> = Omit<
  CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
      : Record<string, unknown>
  >,
  "$inferSelect" | "$inferInsert"
>;

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

/** Defines a graph-native plugin collection without creating runtime state. */
export function defineCollection<S extends JsonSchema>(
  input: CollectionDefinitionInput<S>,
): CollectionDefinition<
  S,
  S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
    : Record<string, unknown>
> {
  if (!input.schema || typeof input.schema !== "object") {
    throw new TypeError("Collection schema is required.");
  }
  const name = requiredText(input.name, "Collection name");
  const definition = {
    ...input,
    name,
    keys: Object.freeze([...(input.keys ?? [{ property: "id" }])]),
    timestamps: Object.freeze(
      input.timestamps ?? { createdAt: "createdAt", updatedAt: "updatedAt" },
    ),
    defaults: Object.freeze({ ...(input.defaults ?? {}) }),
    indexes: Object.freeze([...(input.indexes ?? [])]),
    relations: Object.freeze({ ...(input.relations ?? {}) }),
    ...(input.search
      ? {
        search: Object.freeze({
          ...input.search,
          fields: Object.freeze([...input.search.fields]),
        }),
      }
      : {}),
    ...(input.content
      ? {
        content: Object.freeze({
          fields: Object.freeze([...input.content.fields]),
        }),
      }
      : {}),
    ...(input.hooks ? { hooks: Object.freeze({ ...input.hooks }) } : {}),
  };
  return Object.freeze(definition) as CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
      : Record<string, unknown>
  >;
}

function createRelation(
  type: CollectionRelation["type"],
  collection: string,
  foreignKey: string,
  edgeType?: string,
): CollectionRelation {
  return Object.freeze({
    type,
    collection: requiredText(collection, "Relation collection"),
    foreignKey: requiredText(foreignKey, "Relation foreign key"),
    ...(edgeType === undefined
      ? {}
      : { edgeType: requiredText(edgeType, "Relation edge type") }),
  });
}

export type CollectionRelationFactory = Readonly<{
  hasOne(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): CollectionRelation;
  hasMany(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): CollectionRelation;
  belongsTo(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): CollectionRelation;
}>;

export type CollectionIndexFactory = Readonly<{
  field(field: string): CollectionIndex;
  composite(...fields: string[]): CollectionIndex;
  unique(fields: string | readonly string[]): CollectionIndex;
  gin(field: string): CollectionIndex;
  gist(field: string): CollectionIndex;
}>;

export const collectionRelation: CollectionRelationFactory = Object.freeze({
  hasOne: (collection: string, foreignKey: string, edgeType?: string) =>
    createRelation("hasOne", collection, foreignKey, edgeType),
  hasMany: (collection: string, foreignKey: string, edgeType?: string) =>
    createRelation("hasMany", collection, foreignKey, edgeType),
  belongsTo: (collection: string, foreignKey: string, edgeType?: string) =>
    createRelation("belongsTo", collection, foreignKey, edgeType),
});

export const collectionIndex: CollectionIndexFactory = Object.freeze({
  field: (field: string): CollectionIndex => requiredText(field, "Index field"),
  composite: (...fields: string[]): CollectionIndex =>
    Object.freeze(fields.map((field) => requiredText(field, "Index field"))),
  unique: (fields: string | readonly string[]): CollectionIndex =>
    Object.freeze({ fields, unique: true }),
  gin: (field: string): CollectionIndex =>
    Object.freeze({ fields: requiredText(field, "Index field"), type: "gin" }),
  gist: (field: string): CollectionIndex =>
    Object.freeze({ fields: requiredText(field, "Index field"), type: "gist" }),
});

/** Concise aliases kept for collection declarations. */
export const relation: CollectionRelationFactory = collectionRelation;
export const index: CollectionIndexFactory = collectionIndex;
