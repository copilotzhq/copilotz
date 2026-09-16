import type { ScopedCollectionReadOptions } from "./read-options.ts";
import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type { FromSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CollectionAggregateQuery, CollectionQuery } from "./types.ts";

export type CollectionNamedQuerySchema = Exclude<JsonSchema, boolean>;

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
  /** Direction of the projected edge relative to the owning Collection. */
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
    /** Optional semantic event type for this command. Defaults to `<collection>.updated`. */
    event?: string;
    input?: JsonSchema;
    mutate(
      context: CollectionMutateContext<TRecord>,
    ): CollectionMutatePatch<TRecord> | void;
  }>;

export type CollectionNamedQueryRead = Readonly<{
  get(
    collection: string,
    id: string,
    options?: ScopedCollectionReadOptions,
  ): Promise<Record<string, unknown> | null>;
  list(
    collection: string,
    query?: CollectionQuery,
    options?: ScopedCollectionReadOptions,
  ): Promise<readonly Record<string, unknown>[]>;
  aggregate(
    collection: string,
    query: CollectionAggregateQuery,
    options?: Pick<ScopedCollectionReadOptions, "signal">,
  ): Promise<readonly Record<string, string | number | boolean | null>[]>;
}>;

export type CollectionNamedQuery = Readonly<{
  /** Optional JSON Schema validated before this query runs. */
  inputSchema?: CollectionNamedQuerySchema;
  /** Optional JSON Schema validated against the complete query result. */
  outputSchema?: CollectionNamedQuerySchema;
  filter?: (
    context: Readonly<{ input: Record<string, unknown> }>,
  ) => CollectionQuery["where"];
  query?: (
    context: Readonly<{ input: Record<string, unknown> }>,
  ) => CollectionQuery;
  select?: (
    context: Readonly<{
      input: Record<string, unknown>;
      read: CollectionNamedQueryRead;
    }>,
  ) =>
    | readonly Record<string, unknown>[]
    | Promise<readonly Record<string, unknown>[]>;
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

const RESERVED_COLLECTION_MEMBERS = [
  "create",
  "update",
  "delete",
  "mutate",
  "get",
  "list",
  "query",
  "search",
  "definition",
] as const;

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
  if ((RESERVED_COLLECTION_MEMBERS as readonly string[]).includes(name)) {
    throw new TypeError(
      `Collection ${kind} '${name}' collides with a kernel method.`,
    );
  }
  return name;
}

function isSchema(value: unknown): value is CollectionNamedQuerySchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalQuerySchema(
  queryName: string,
  name: "inputSchema" | "outputSchema",
  value: unknown,
): CollectionNamedQuerySchema | undefined {
  if (value === undefined) return undefined;
  if (!isSchema(value)) {
    throw new TypeError(
      `Collection query '${queryName}' ${name} must be a JSON Schema object.`,
    );
  }
  return (structuredClone(value)) as CollectionNamedQuerySchema;
}

function createRelation(
  type: CollectionRelation["type"],
  collection: string,
  foreignKey: string,
  edgeType?: string,
  edge?: CollectionRelation["edge"],
): CollectionRelation {
  return ({
    type,
    collection: requiredText(collection, "Relation collection"),
    foreignKey: requiredText(foreignKey, "Relation foreign key"),
    ...(edgeType === undefined
      ? {}
      : { edgeType: requiredText(edgeType, "Relation edge type") }),
    ...(edge ? { edge } : {}),
  } as const);
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
}> = {
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
} as const;

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
    ? (Object.fromEntries(
      Object.entries(
        input.commands as Record<string, CollectionCommandDefinition>,
      ).map(([command, definition]) => {
        const commandName = requiredMemberName(command, "command");
        if (typeof definition.mutate !== "function") {
          throw new TypeError(
            `Collection command '${commandName}' requires a mutate function.`,
          );
        }
        const event = definition.event?.trim();
        if (event !== undefined && !/^[a-z][a-z0-9_.-]*$/i.test(event)) {
          throw new TypeError(
            `Collection command '${commandName}' has invalid event type '${event}'.`,
          );
        }
        return [
          commandName,
          { ...definition, ...(event ? { event } : {}) } as const,
        ];
      }),
    ))
    : undefined;
  const queries = input.queries
    ? (Object.fromEntries(
      Object.entries(
        input.queries as Record<string, CollectionNamedQuery>,
      ).map(([queryName, definition]) => {
        const name = requiredMemberName(queryName, "query");
        if (
          typeof definition.filter !== "function" &&
          typeof definition.query !== "function" &&
          typeof definition.select !== "function"
        ) {
          throw new TypeError(
            `Collection query '${name}' requires filter, query, or select.`,
          );
        }
        const inputSchema = optionalQuerySchema(
          name,
          "inputSchema",
          definition.inputSchema,
        );
        const outputSchema = optionalQuerySchema(
          name,
          "outputSchema",
          definition.outputSchema,
        );
        return [
          name,
          {
            ...definition,
            ...(inputSchema ? { inputSchema } : {}),
            ...(outputSchema ? { outputSchema } : {}),
          } as const,
        ];
      }),
    ))
    : undefined;
  return ({
    ...input,
    name,
    timestamps: input.timestamps ??
      { createdAt: "createdAt", updatedAt: "updatedAt" },
    defaults: { ...(input.defaults ?? {}) } as const,
    indexes: [...(input.indexes ?? [])] as const,
    relations: { ...(input.relations ?? {}) } as const,
    ...(input.identity
      ? {
        identity: {
          sourceType: requiredText(
            input.identity.sourceType,
            "Identity sourceType",
          ),
          sourceField: requiredText(
            input.identity.sourceField,
            "Identity sourceField",
          ),
        } as const,
      }
      : {}),
    ...(input.search
      ? {
        search: {
          ...input.search,
          fields: [...input.search.fields] as const,
        } as const,
      }
      : {}),
    ...(input.content
      ? {
        content: {
          fields: [...input.content.fields] as const,
        } as const,
      }
      : {}),
    ...(commands ? { commands } : {}),
    ...(queries ? { queries } : {}),
  } as const) as CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "namespace" | "createdAt" | "updatedAt"> & {
        id?: string;
      }
      : Record<string, unknown>
  >;
}
