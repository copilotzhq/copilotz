/**
 * Collections API for Copilotz.
 * 
 * Provides a type-safe, developer-friendly interface for defining custom
 * collections that map to the underlying graph structure (nodes + edges).
 * 
 * @module
 * 
 * @example
 * ```ts
 * import { defineCollection } from 'copilotz/collections';
 * 
 * const customerSchema = {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string' },
 *     email: { type: 'string' },
 *     plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
 *   },
 *   required: ['id', 'email'],
 * } as const;
 * 
 * export const customers = defineCollection({
 *   name: 'customer',
 *   schema: customerSchema,
 *   indexes: ['email'],
 *   search: { enabled: true, fields: ['email'] },
 * });
 * 
 * // Type inference
 * type Customer = typeof customers.$inferSelect;
 * ```
 */

import type { JsonSchema } from "omnipg";
import type {
  CollectionDefinition,
  CollectionInput,
  CollectionCrud,
  ScopedCollectionCrud,
  CollectionsMap,
  ScopedCollectionsMap,
  CollectionsConfig,
  WhereFilter,
  WhereOperators,
  QueryOptions,
  SearchOptions,
  IndexDefinition,
  RelationDefinition,
  SearchConfig,
  CollectionHooks,
  HookContext,
  SortOrder,
} from "./types.ts";

// Re-export types
export type {
  CollectionDefinition,
  CollectionInput,
  CollectionCrud,
  ScopedCollectionCrud,
  CollectionsMap,
  ScopedCollectionsMap,
  CollectionsConfig,
  WhereFilter,
  WhereOperators,
  QueryOptions,
  SearchOptions,
  IndexDefinition,
  RelationDefinition,
  SearchConfig,
  CollectionHooks,
  HookContext,
  SortOrder,
};

// Re-export CRUD factory
export { createCollectionCrud } from "./crud.ts";

// Re-export manager
export { createCollectionsManager, createScopedCollections } from "./manager.ts";

/**
 * Defines a new collection with JSON Schema.
 * 
 * The collection definition includes:
 * - Schema: JSON Schema for data validation and type inference
 * - Indexes: Fields to index for fast queries
 * - Relations: Relationships to other collections
 * - Search: Semantic search configuration
 * - Hooks: Lifecycle hooks for create/update/delete
 * 
 * @param config - Collection configuration
 * @returns Collection definition with type inference
 * 
 * @example
 * ```ts
 * const schema = {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string', readOnly: true },
 *     email: { type: 'string' },
 *     name: { type: ['string', 'null'] },
 *     plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
 *     createdAt: { type: 'string', format: 'date-time' },
 *     updatedAt: { type: 'string', format: 'date-time' },
 *   },
 *   required: ['id', 'email', 'plan'],
 * } as const;
 * 
 * const customers = defineCollection({
 *   name: 'customer',
 *   schema,
 *   keys: [{ property: 'id' }],
 *   timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
 *   defaults: { id: () => ulid(), plan: 'free' },
 *   indexes: ['email', ['plan', 'createdAt']],
 *   relations: {
 *     orders: { type: 'hasMany', collection: 'order', foreignKey: 'customerId' },
 *   },
 *   search: { enabled: true, fields: ['name', 'email'] },
 * });
 * 
 * // Infer types
 * type Customer = typeof customers.$inferSelect;
 * type NewCustomer = typeof customers.$inferInsert;
 * ```
 */
/**
 * Define a collection. Use `as const` on your schema for proper type inference.
 * 
 * For type inference, access `$inferSelect` and `$inferInsert` on the returned collection:
 * ```ts
 * const customers = defineCollection({ name: 'customer', schema: customerSchema });
 * type Customer = typeof customers.$inferSelect;
 * ```
 */
export function defineCollection<S extends JsonSchema>(
  config: CollectionInput<S>,
): CollectionDefinition<S> {
  // Validate required fields
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Collection name is required");
  }
  if (!config.schema || typeof config.schema !== "object") {
    throw new Error("Collection schema is required");
  }

  // Set defaults
  const normalized = {
    ...config,
    keys: config.keys ?? [{ property: "id" }],
    timestamps: config.timestamps ?? {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: config.defaults ?? {},
    indexes: config.indexes ?? [],
    relations: config.relations ?? {},
  };

  // The $inferSelect and $inferInsert are phantom types for TypeScript
  // They don't exist at runtime
  return normalized as unknown as CollectionDefinition<S>;
}

/**
 * Helper to create a relation definition.
 */
export const relation = {
  /**
   * Define a hasOne relation (one-to-one, this record owns the relation).
   */
  hasOne: (collection: string, foreignKey: string, edgeType?: string): RelationDefinition => ({
    type: "hasOne",
    collection,
    foreignKey,
    edgeType,
  }),

  /**
   * Define a hasMany relation (one-to-many, this record owns the relation).
   */
  hasMany: (collection: string, foreignKey: string, edgeType?: string): RelationDefinition => ({
    type: "hasMany",
    collection,
    foreignKey,
    edgeType,
  }),

  /**
   * Define a belongsTo relation (many-to-one, foreign key is on this record).
   */
  belongsTo: (collection: string, foreignKey: string, edgeType?: string): RelationDefinition => ({
    type: "belongsTo",
    collection,
    foreignKey,
    edgeType,
  }),
};

/**
 * Helper to create index definitions.
 */
export const index = {
  /**
   * Create a simple field index.
   */
  field: (field: string): IndexDefinition => field,

  /**
   * Create a composite index on multiple fields.
   */
  composite: (...fields: string[]): IndexDefinition => fields,

  /**
   * Create a unique index.
   */
  unique: (field: string | string[]): IndexDefinition => ({
    fields: field,
    unique: true,
  }),

  /**
   * Create a GIN index (for arrays and JSONB).
   */
  gin: (field: string): IndexDefinition => ({
    fields: field,
    type: "gin",
  }),

  /**
   * Create a GiST index (for full-text search).
   */
  gist: (field: string): IndexDefinition => ({
    fields: field,
    type: "gist",
  }),

  /**
   * Create a partial index with a condition.
   */
  partial: (field: string | string[], where: Record<string, unknown>): IndexDefinition => ({
    fields: field,
    where,
  }),
};

