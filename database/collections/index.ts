import type { JsonSchema } from "omnipg";
import type { FromSchema } from "json-schema-to-ts";
import type {
  CollectionDefinition,
  CollectionInput,
  IndexDefinition,
  RelationDefinition,
} from "./types.ts";

export type * from "./types.ts";
export { createEventCollectionsManager } from "./event-manager.ts";

/** Define a graph collection with inferred select and insert types. */
export function defineCollection<S extends JsonSchema>(
  config: CollectionInput<S>,
): CollectionDefinition<
  S,
  S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
    : Record<string, unknown>
> {
  if (!config.name?.trim()) throw new TypeError("Collection name is required.");
  if (!config.schema || typeof config.schema !== "object") {
    throw new TypeError("Collection schema is required.");
  }
  return {
    ...config,
    keys: config.keys ?? [{ property: "id" }],
    timestamps: config.timestamps ?? {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: config.defaults ?? {},
    indexes: config.indexes ?? [],
    relations: config.relations ?? {},
  } as unknown as CollectionDefinition<
    S,
    S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
    S extends JsonSchema
      ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
      : Record<string, unknown>
  >;
}

export interface RelationHelpers {
  hasOne(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition;
  hasMany(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition;
  belongsTo(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition;
}

export const relation: RelationHelpers = {
  hasOne(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition {
    return { type: "hasOne", collection, foreignKey, edgeType };
  },
  hasMany(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition {
    return { type: "hasMany", collection, foreignKey, edgeType };
  },
  belongsTo(
    collection: string,
    foreignKey: string,
    edgeType?: string,
  ): RelationDefinition {
    return { type: "belongsTo", collection, foreignKey, edgeType };
  },
};

export interface IndexHelpers {
  field(field: string): IndexDefinition;
  composite(...fields: string[]): IndexDefinition;
  unique(fields: string | string[]): IndexDefinition;
  gin(field: string): IndexDefinition;
  gist(field: string): IndexDefinition;
}

export const index: IndexHelpers = {
  field: (field: string): IndexDefinition => field,
  composite: (...fields: string[]): IndexDefinition => fields,
  unique: (fields: string | string[]): IndexDefinition => ({
    fields,
    unique: true,
  }),
  gin: (field: string): IndexDefinition => ({ fields: field, type: "gin" }),
  gist: (field: string): IndexDefinition => ({ fields: field, type: "gist" }),
};
