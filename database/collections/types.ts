/**
 * Type definitions for the Collections API.
 * 
 * Provides a type-safe, developer-friendly interface for defining and
 * working with custom collections that map to the graph structure.
 * 
 * @module
 */

import type { JsonSchema } from "omnipg";
import type { FromSchema } from "json-schema-to-ts";

// ============================================
// SCHEMA TYPES
// ============================================

/**
 * Index definition for a collection field.
 */
export type IndexDefinition =
  | string
  | string[]
  | {
      fields: string | string[];
      unique?: boolean;
      type?: "btree" | "gin" | "gist" | "brin";
      where?: Record<string, unknown>;
    };

/**
 * Relation definition between collections.
 */
export interface RelationDefinition {
  /** Relation type */
  type: "hasOne" | "hasMany" | "belongsTo";
  /** Target collection name */
  collection: string;
  /** Foreign key field name */
  foreignKey: string;
  /** Edge type in graph (auto-generated if not specified) */
  edgeType?: string;
}

/**
 * Search configuration for semantic search.
 */
export interface SearchConfig {
  /** Enable semantic search for this collection */
  enabled: boolean;
  /** Fields to concatenate and embed for search */
  fields: string[];
}

/**
 * Lifecycle hooks for collection operations.
 */
type HookCallback<T, R> = {
  bivarianceHack: (record: T, ctx: HookContext) => R;
}["bivarianceHack"];

export interface CollectionHooks<T> {
  beforeCreate?: (data: Record<string, unknown>, ctx: HookContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterCreate?: HookCallback<T, void | Promise<void>>;
  beforeUpdate?: (data: Record<string, unknown>, ctx: HookContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterUpdate?: HookCallback<T, void | Promise<void>>;
  beforeDelete?: (filter: Record<string, unknown>, ctx: HookContext) => void | Promise<void>;
  afterDelete?: (deleted: number, ctx: HookContext) => void | Promise<void>;
}

export interface HookContext {
  namespace: string;
  userId?: string;
}

export type CollectionMethodMap = Record<
  string,
  (...args: any[]) => unknown | Promise<unknown>
>;

export interface CollectionMethodContext<
  TSelect = unknown,
  TInsert = unknown,
> {
  collection: ScopedCollectionCrud<TSelect, TInsert> & CollectionMethodMap;
  collections: Record<string, unknown>;
  rootCollections: Record<string, unknown>;
  namespace: string;
  ops: unknown;
}

export type CollectionMethodFactory<
  TSelect = unknown,
  TInsert = unknown,
> = (
  context: CollectionMethodContext<TSelect, TInsert>,
) => CollectionMethodMap;

// ============================================
// COLLECTION DEFINITION
// ============================================

/**
 * Collection definition with JSON Schema and configuration.
 * 
 * @example
 * ```ts
 * const customers = defineCollection({
 *   name: 'customer',
 *   schema: {
 *     type: 'object',
 *     properties: {
 *       id: { type: 'string' },
 *       email: { type: 'string' },
 *       plan: { type: 'string', enum: ['free', 'pro'] },
 *     },
 *     required: ['id', 'email'],
 *   } as const,
 *   indexes: ['email'],
 * });
 * 
 * type Customer = typeof customers.$inferSelect;
 * ```
 */
export interface CollectionDefinition<
  S extends JsonSchema = JsonSchema,
  // Use conditional to defer type evaluation
  TSelect = S extends JsonSchema ? FromSchema<S> : Record<string, unknown>,
  TInsert = S extends JsonSchema 
    ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
    : Record<string, unknown>,
> {
  /** Collection name (maps to nodes.type) */
  name: string;
  /** JSON Schema for the collection data */
  schema: S;
  /** Primary key field(s) - defaults to ['id'] */
  keys?: Array<{ property: string }>;
  /** Auto-managed timestamp fields */
  timestamps?: {
    createdAt?: string;
    updatedAt?: string;
  };
  /** Default values for fields */
  defaults?: Record<string, (() => unknown) | unknown>;
  /** Index definitions for fast queries */
  indexes?: IndexDefinition[];
  /** Relations to other collections */
  relations?: Record<string, RelationDefinition>;
  /** Semantic search configuration */
  search?: SearchConfig;
  /** Lifecycle hooks */
  hooks?: CollectionHooks<TSelect>;
  /** Optional custom methods bound to the scoped collection instance. */
  methods?: CollectionMethodFactory<TSelect, TInsert>;

  // Type inference markers (phantom types - not used at runtime)
  readonly $inferSelect: TSelect;
  readonly $inferInsert: TInsert;
  readonly $inferMethods: CollectionMethodMap;
}

/**
 * Input type for defineCollection (without phantom types).
 */
export type CollectionInput<S extends JsonSchema = JsonSchema> = Omit<
  CollectionDefinition<S, S extends JsonSchema ? FromSchema<S> : Record<string, unknown>, S extends JsonSchema
    ? Omit<FromSchema<S>, "id" | "createdAt" | "updatedAt"> & { id?: string }
    : Record<string, unknown>>,
  "$inferSelect" | "$inferInsert" | "$inferMethods"
>;

// ============================================
// QUERY TYPES
// ============================================

/**
 * Comparison operators for queries.
 */
export type WhereOperators<T> = {
  /** Equal to */
  $eq?: T;
  /** Not equal to */
  $ne?: T;
  /** In array */
  $in?: T[];
  /** Not in array */
  $nin?: T[];
  /** Greater than */
  $gt?: T;
  /** Greater than or equal */
  $gte?: T;
  /** Less than */
  $lt?: T;
  /** Less than or equal */
  $lte?: T;
  /** Array contains value */
  $contains?: T extends (infer U)[] ? U : never;
  /** Array contains all values */
  $containsAll?: T extends (infer U)[] ? U[] : never;
  /** Array contains any value */
  $containsAny?: T extends (infer U)[] ? U[] : never;
  /** LIKE pattern match */
  $like?: string;
  /** Case-insensitive LIKE */
  $ilike?: string;
  /** Regex pattern match */
  $regex?: string;
  /** Starts with */
  $startsWith?: string;
  /** Ends with */
  $endsWith?: string;
  /** Is null */
  $isNull?: boolean;
  /** Has JSON key */
  $hasKey?: string;
};

/**
 * Where filter for queries.
 */
export type WhereFilter<T> = {
  [K in keyof T]?: T[K] | WhereOperators<T[K]>;
} & {
  $and?: WhereFilter<T>[];
  $or?: WhereFilter<T>[];
  $not?: WhereFilter<T>;
} & Record<string, unknown>;

/**
 * Sort order specification.
 */
export type SortOrder<T> = Array<[keyof T | string, "asc" | "desc"]>;

/**
 * Cursor-based pagination metadata for collection queries.
 */
export interface CollectionPageInfo {
  /** Whether there are more records before this page. */
  hasMoreBefore: boolean;
  /** Whether there are more records after this page. */
  hasMoreAfter: boolean;
  /** Cursor value for the first record in the page. */
  startCursor: string | null;
  /** Cursor value for the last record in the page. */
  endCursor: string | null;
  /** Field used to resolve cursors for this page. */
  cursorField: string;
}

/**
 * Paginated collection result.
 */
export interface CollectionPage<T> {
  data: T[];
  pageInfo: CollectionPageInfo;
}

/**
 * Query options for find operations.
 */
export interface QueryOptions<T = unknown> {
  /** Namespace scope (required) */
  namespace: string;
  /** Maximum number of results */
  limit?: number;
  /** Number of results to skip */
  offset?: number;
  /** Sort order */
  sort?: SortOrder<T>;
  /** Relations to populate (dot notation for nested) */
  populate?: string[];
}

/**
 * Cursor-based query options for findPage operations.
 */
export interface PageOptions<T = unknown> extends QueryOptions<T> {
  /** Page backwards from this cursor value. */
  before?: string;
  /** Page forwards from this cursor value. */
  after?: string;
  /** Field used to resolve cursor values; defaults to `id`. */
  cursorField?: keyof T | string;
}

/**
 * Options for semantic search.
 */
export interface SearchOptions {
  /** Namespace scope (required) */
  namespace: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  threshold?: number;
  /** Additional filter conditions */
  where?: Record<string, unknown>;
  /** Relations to populate */
  populate?: string[];
}

// ============================================
// CRUD INTERFACE
// ============================================

/**
 * CRUD interface for a collection with explicit namespace.
 */
export interface CollectionCrud<TSelect, TInsert> {
  /**
   * Create a single record.
   */
  create(data: TInsert, options: { namespace: string }): Promise<TSelect>;

  /**
   * Create multiple records.
   */
  createMany(
    data: TInsert[],
    options: { namespace: string },
  ): Promise<TSelect[]>;

  /**
   * Find multiple records matching filter.
   */
  find(
    filter?: WhereFilter<TSelect>,
    options?: QueryOptions<TSelect>,
  ): Promise<TSelect[]>;

  /**
   * Find a single page of records using cursor-based pagination.
   */
  findPage(
    filter?: WhereFilter<TSelect>,
    options?: PageOptions<TSelect>,
  ): Promise<CollectionPage<TSelect>>;

  /**
   * Find a single record matching filter.
   */
  findOne(
    filter: WhereFilter<TSelect>,
    options?: Omit<QueryOptions<TSelect>, "limit" | "offset">,
  ): Promise<TSelect | null>;

  /**
   * Find a record by ID.
   */
  findById(
    id: string,
    options: { namespace: string; populate?: string[] },
  ): Promise<TSelect | null>;

  /**
   * Update the first record matching filter.
   */
  update(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    options: { namespace: string },
  ): Promise<TSelect | null>;

  /**
   * Update all records matching filter.
   */
  updateMany(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    options: { namespace: string },
  ): Promise<{ updated: number }>;

  /**
   * Delete the first record matching filter.
   */
  delete(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<{ deleted: number }>;

  /**
   * Delete all records matching filter.
   */
  deleteMany(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<{ deleted: number }>;

  /**
   * Create or update a record.
   */
  upsert(
    filter: WhereFilter<TSelect>,
    data: TInsert,
    options: { namespace: string },
  ): Promise<TSelect>;

  /**
   * Count records matching filter.
   */
  count(
    filter?: WhereFilter<TSelect>,
    options?: { namespace: string },
  ): Promise<number>;

  /**
   * Check if any record matches filter.
   */
  exists(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<boolean>;

  /**
   * Semantic search (only available if search is enabled).
   */
  search?(
    query: string,
    options: SearchOptions,
  ): Promise<Array<TSelect & { _similarity: number }>>;

  /**
   * Find similar records to a given record.
   */
  findSimilar?(
    id: string,
    options: { namespace: string; limit?: number; threshold?: number },
  ): Promise<Array<TSelect & { _similarity: number }>>;
}

/**
 * Scoped CRUD interface with namespace pre-applied.
 */
export interface ScopedCollectionCrud<TSelect, TInsert> {
  create(data: TInsert): Promise<TSelect>;
  createMany(data: TInsert[]): Promise<TSelect[]>;
  find(
    filter?: WhereFilter<TSelect>,
    options?: Omit<QueryOptions<TSelect>, "namespace">,
  ): Promise<TSelect[]>;
  findPage(
    filter?: WhereFilter<TSelect>,
    options?: Omit<PageOptions<TSelect>, "namespace">,
  ): Promise<CollectionPage<TSelect>>;
  findOne(
    filter: WhereFilter<TSelect>,
    options?: { populate?: string[] },
  ): Promise<TSelect | null>;
  findById(
    id: string,
    options?: { populate?: string[] },
  ): Promise<TSelect | null>;
  update(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
  ): Promise<TSelect | null>;
  updateMany(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
  ): Promise<{ updated: number }>;
  delete(filter: WhereFilter<TSelect>): Promise<{ deleted: number }>;
  deleteMany(filter: WhereFilter<TSelect>): Promise<{ deleted: number }>;
  upsert(filter: WhereFilter<TSelect>, data: TInsert): Promise<TSelect>;
  count(filter?: WhereFilter<TSelect>): Promise<number>;
  exists(filter: WhereFilter<TSelect>): Promise<boolean>;
  search?(
    query: string,
    options?: Omit<SearchOptions, "namespace">,
  ): Promise<Array<TSelect & { _similarity: number }>>;
  findSimilar?(
    id: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<Array<TSelect & { _similarity: number }>>;
}

export type ScopedCollectionWithMethods<
  TSelect,
  TInsert,
  TMethods extends CollectionMethodMap = CollectionMethodMap,
> = ScopedCollectionCrud<TSelect, TInsert> & TMethods;

export type CollectionMethodsOf<TDefinition> =
  TDefinition extends { methods?: (...args: any[]) => infer TMethods }
    ? TMethods extends CollectionMethodMap
      ? TMethods
      : Record<string, never>
    : Record<string, never>;

// ============================================
// COLLECTIONS MAP TYPES
// ============================================

/**
 * Map of collection names to their CRUD interfaces.
 */
export type CollectionsMap<T extends readonly CollectionDefinition[]> = {
  [K in T[number] as K["name"]]: CollectionCrud<
    K["$inferSelect"],
    K["$inferInsert"]
  >;
} & {
  /** Get scoped client with namespace pre-applied */
  withNamespace: (namespace: string) => ScopedCollectionsMap<T>;
};

/**
 * Map of collection names to their scoped CRUD interfaces.
 */
export type ScopedCollectionsMap<T extends readonly CollectionDefinition[]> = {
  [K in T[number] as K["name"]]: ScopedCollectionWithMethods<
    K["$inferSelect"],
    K["$inferInsert"],
    CollectionMethodsOf<K>
  >;
};

// ============================================
// CONFIGURATION
// ============================================

/**
 * Configuration for the collections manager.
 */
export interface CollectionsConfig {
  /** Auto-create indexes on startup */
  autoIndex?: boolean;
  /** Validate writes against schema */
  validateOnWrite?: boolean;
  /** Embedding function for semantic search */
  embeddingFn?: (text: string) => Promise<number[]>;
  /** Default namespace for operations */
  defaultNamespace?: string;
}
