import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type { FromSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CollectionQuery } from "./types.ts";

export type CollectionIndex =
  | string
  | readonly string[]
  | Readonly<{
    fields: string | readonly string[];
    unique?: boolean;
    type?: "btree" | "gin" | "gist" | "brin";
  }>;

export type CollectionRelation = Readonly<{
  type: "hasOne" | "hasMany" | "belongsTo";
  collection: string;
  foreignKey: string;
  edgeType?: string;
  /** Default parent→child. `child-to-parent` is `participates_in` (participant→thread). */
  edge?: "parent-to-child" | "child-to-parent";
}>;

export type CollectionHookContext = Readonly<{
  namespace: string;
}>;

export type CollectionMutateContext<TRecord> = Readonly<{
  current: Readonly<TRecord>;
  input: unknown;
}>;

export type CollectionMutatePatch<TRecord> = Readonly<{
  set?: Partial<TRecord>;
  unset?: readonly string[];
}>;

export type CollectionCommandDefinition<TRecord = Record<string, unknown>> =
  Readonly<{
    input?: JsonSchema;
    mutate(
      context: CollectionMutateContext<TRecord>,
    ): CollectionMutatePatch<TRecord> | void;
  }>;

export type CollectionNamedQuery = Readonly<{
  filter(context: Readonly<{ input: Record<string, unknown> }>): CollectionQuery["where"];
}>;

export type CollectionDefinition<
  S extends JsonSchema = JsonSchema,
  TSelect = S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  TInsert = S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "namespace" | "createdAt" | "updatedAt"> & {
      id?: string;
    }
    : Record<string, unknown>,
> = Readonly<{
  name: string;
  schema: S;
  timestamps?: Readonly<{ createdAt?: string; updatedAt?: string }>;
  defaults?: Readonly<Record<string, unknown>>;
  indexes?: readonly CollectionIndex[];
  relations?: Readonly<Record<string, CollectionRelation>>;
  identity?: Readonly<{ sourceType: string; sourceField: string }>;
  search?: Readonly<{ enabled: boolean; fields: readonly string[] }>;
  content?: Readonly<{ fields: readonly string[] }>;
  beforeCreate?: (
    data: Record<string, unknown>,
    context: CollectionHookContext,
  ) => Record<string, unknown>;
  beforeUpdate?: (
    data: Record<string, unknown>,
    context: CollectionHookContext,
  ) => Record<string, unknown>;
  beforeDelete?: (
    data: Record<string, unknown>,
    context: CollectionHookContext,
  ) => void;
  commands?: Readonly<Record<string, CollectionCommandDefinition>>;
  queries?: Readonly<Record<string, CollectionNamedQuery>>;
  readonly $inferSelect: TSelect;
  readonly $inferInsert: TInsert;
}>;

export type CollectionDefinitionInput<S extends JsonSchema = JsonSchema> = Omit<
  CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "namespace" | "createdAt" | "updatedAt"> & {
        id?: string;
      }
      : Record<string, unknown>
  >,
  "$inferSelect" | "$inferInsert"
>;

const RESERVED_COLLECTION_MEMBERS = Object.freeze([
  "create",
  "update",
  "delete",
  "mutate",
  "get",
  "list",
  "query",
  "search",
  "definition",
]);

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function requiredMemberName(value: string, kind: string): string {
  const name = requiredText(value, `Collection ${kind} name`);
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) {
    throw new TypeError(`Invalid collection ${kind} '${name}'.`);
  }
  if (RESERVED_COLLECTION_MEMBERS.includes(name)) {
    throw new TypeError(`Collection ${kind} '${name}' collides with a kernel method.`);
  }
  return name;
}

function createRelation(
  type: CollectionRelation["type"],
  collection: string,
  foreignKey: string,
  edgeType?: string,
  edge?: CollectionRelation["edge"],
): CollectionRelation {
  return Object.freeze({
    type,
    collection: requiredText(collection, "Relation collection"),
    foreignKey: requiredText(foreignKey, "Relation foreign key"),
    ...(edgeType === undefined
      ? {}
      : { edgeType: requiredText(edgeType, "Relation edge type") }),
    ...(edge ? { edge } : {}),
  });
}

type CollectionRelationFactory = (
  collection: string,
  foreignKey: string,
  edgeType?: string,
  edge?: CollectionRelation["edge"],
) => CollectionRelation;

export const relation: Readonly<{
  hasOne: CollectionRelationFactory;
  hasMany: CollectionRelationFactory;
  belongsTo: CollectionRelationFactory;
}> = Object.freeze({
  hasOne: (
    collection: string,
    foreignKey: string,
    edgeType?: string,
    edge?: CollectionRelation["edge"],
  ): CollectionRelation =>
    createRelation("hasOne", collection, foreignKey, edgeType, edge),
  hasMany: (
    collection: string,
    foreignKey: string,
    edgeType?: string,
    edge?: CollectionRelation["edge"],
  ): CollectionRelation =>
    createRelation("hasMany", collection, foreignKey, edgeType, edge),
  belongsTo: (
    collection: string,
    foreignKey: string,
    edgeType?: string,
    edge?: CollectionRelation["edge"],
  ): CollectionRelation =>
    createRelation("belongsTo", collection, foreignKey, edgeType, edge),
});

/** Defines one canonical collection. The runtime derives commands and types. */
export function defineCollection<S extends JsonSchema>(
  input: CollectionDefinitionInput<S>,
): CollectionDefinition<
  S,
  S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "namespace" | "createdAt" | "updatedAt"> & {
      id?: string;
    }
    : Record<string, unknown>
> {
  if (!input.schema || typeof input.schema !== "object") {
    throw new TypeError("Collection schema is required.");
  }
  const name = requiredText(input.name, "Collection name");
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) {
    throw new TypeError(`Collection name '${name}' cannot form an event type.`);
  }
  const commands = input.commands
    ? Object.freeze(Object.fromEntries(
      Object.entries(
        input.commands as Record<string, CollectionCommandDefinition>,
      ).map(([command, definition]) => {
        const commandName = requiredMemberName(command, "command");
        if (typeof definition.mutate !== "function") {
          throw new TypeError(
            `Collection command '${commandName}' requires a mutate function.`,
          );
        }
        return [commandName, Object.freeze({ ...definition })];
      }),
    ))
    : undefined;
  const queries = input.queries
    ? Object.freeze(Object.fromEntries(
      Object.entries(
        input.queries as Record<string, CollectionNamedQuery>,
      ).map(([queryName, definition]) => {
        const name = requiredMemberName(queryName, "query");
        if (typeof definition.filter !== "function") {
          throw new TypeError(
            `Collection query '${name}' requires a filter function.`,
          );
        }
        return [name, Object.freeze({ ...definition })];
      }),
    ))
    : undefined;
  return Object.freeze({
    ...input,
    name,
    timestamps: Object.freeze(
      input.timestamps ?? { createdAt: "createdAt", updatedAt: "updatedAt" },
    ),
    defaults: Object.freeze({ ...(input.defaults ?? {}) }),
    indexes: Object.freeze([...(input.indexes ?? [])]),
    relations: Object.freeze({ ...(input.relations ?? {}) }),
    ...(input.identity
      ? {
        identity: Object.freeze({
          sourceType: requiredText(input.identity.sourceType, "Identity sourceType"),
          sourceField: requiredText(input.identity.sourceField, "Identity sourceField"),
        }),
      }
      : {}),
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
    ...(commands ? { commands } : {}),
    ...(queries ? { queries } : {}),
  }) as CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "namespace" | "createdAt" | "updatedAt"> & {
        id?: string;
      }
      : Record<string, unknown>
  >;
}
