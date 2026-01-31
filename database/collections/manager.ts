/**
 * Collections Manager for Copilotz.
 * 
 * Creates and manages collection CRUD interfaces, providing both
 * explicit namespace and scoped (namespace pre-applied) access patterns.
 * 
 * @module
 */

import type { DbInstance } from "../index.ts";
import type {
  CollectionDefinition,
  CollectionCrud,
  ScopedCollectionCrud,
  CollectionsConfig,
  QueryOptions,
  SearchOptions,
} from "./types.ts";
import { createCollectionCrud } from "./crud.ts";

// ============================================
// TYPES
// ============================================

/**
 * Raw collections map (internal use).
 */
type RawCollectionsMap = Record<string, CollectionCrud<unknown, unknown>>;

/**
 * Scoped collections map (internal use).
 */
type RawScopedCollectionsMap = Record<string, ScopedCollectionCrud<unknown, unknown>>;

/**
 * Collections manager interface.
 */
export interface CollectionsManager<T extends readonly CollectionDefinition[]> {
  /**
   * Access a collection by name with explicit namespace.
   */
  [K: string]: CollectionCrud<unknown, unknown>;
}

// ============================================
// SCOPED COLLECTIONS
// ============================================

/**
 * Creates a scoped collections interface with namespace pre-applied.
 * 
 * @param collections - Raw collections map
 * @param namespace - Namespace to scope all operations to
 * @returns Scoped collections map
 */
export function createScopedCollections(
  collections: RawCollectionsMap,
  namespace: string,
): RawScopedCollectionsMap {
  const scoped: RawScopedCollectionsMap = {};

  for (const [name, crud] of Object.entries(collections)) {
    scoped[name] = {
      create: (data) => crud.create(data, { namespace }),
      
      createMany: (data) => crud.createMany(data, { namespace }),
      
      find: (filter, opts) =>
        crud.find(filter, { ...opts, namespace } as QueryOptions<unknown>),
      
      findOne: (filter, opts) =>
        crud.findOne(filter, { ...opts, namespace }),
      
      findById: (id, opts) =>
        crud.findById(id, { ...opts, namespace }),
      
      update: (filter, data) =>
        crud.update(filter, data, { namespace }),
      
      updateMany: (filter, data) =>
        crud.updateMany(filter, data, { namespace }),
      
      delete: (filter) =>
        crud.delete(filter, { namespace }),
      
      deleteMany: (filter) =>
        crud.deleteMany(filter, { namespace }),
      
      upsert: (filter, data) =>
        crud.upsert(filter, data, { namespace }),
      
      count: (filter) =>
        crud.count(filter, { namespace }),
      
      exists: (filter) =>
        crud.exists(filter, { namespace }),
      
      ...(crud.search
        ? {
            search: (query: string, opts?: Omit<SearchOptions, "namespace">) =>
              crud.search!(query, { ...opts, namespace }),
          }
        : {}),
      
      ...(crud.findSimilar
        ? {
            findSimilar: (id: string, opts?: { limit?: number; threshold?: number }) =>
              crud.findSimilar!(id, { ...opts, namespace }),
          }
        : {}),
    };
  }

  return scoped;
}

// ============================================
// COLLECTIONS MANAGER
// ============================================

/**
 * Creates a collections manager from collection definitions.
 * 
 * The manager provides:
 * - Direct access to collections with explicit namespace
 * - `withNamespace()` method for scoped access
 * 
 * @param db - Database instance
 * @param definitions - Array of collection definitions
 * @param config - Collections configuration
 * @returns Collections manager
 * 
 * @example
 * ```ts
 * const manager = createCollectionsManager(db, [customers, orders], {
 *   embeddingFn: (text) => generateEmbedding(text),
 * });
 * 
 * // Explicit namespace
 * await manager.customer.create(data, { namespace: 'tenant-123' });
 * 
 * // Scoped namespace
 * const scoped = manager.withNamespace('tenant-123');
 * await scoped.customer.create(data);
 * ```
 */
// deno-lint-ignore no-explicit-any
export function createCollectionsManager<T extends readonly CollectionDefinition<any, any, any>[]>(
  db: DbInstance,
  definitions: T,
  config?: CollectionsConfig,
): {
  [K in T[number] as K["name"]]: CollectionCrud<K["$inferSelect"], K["$inferInsert"]>;
} & {
  /** Get scoped client with namespace pre-applied */
  withNamespace: (namespace: string) => {
    [K in T[number] as K["name"]]: ScopedCollectionCrud<K["$inferSelect"], K["$inferInsert"]>;
  };
  /** List all registered collection names */
  getCollectionNames: () => string[];
  /** Check if a collection exists */
  hasCollection: (name: string) => boolean;
} {
  const collections: RawCollectionsMap = {};

  // Create CRUD interface for each collection
  for (const definition of definitions) {
    collections[definition.name] = createCollectionCrud(
      db,
      definition,
      config?.embeddingFn,
    );
  }

  // Create the manager object
  const manager = {
    ...collections,

    /**
     * Get a scoped client with namespace pre-applied to all operations.
     */
    withNamespace: (namespace: string) => {
      return createScopedCollections(collections, namespace);
    },

    /**
     * List all registered collection names.
     */
    getCollectionNames: () => {
      return Object.keys(collections);
    },

    /**
     * Check if a collection exists.
     */
    hasCollection: (name: string) => {
      return name in collections;
    },
  };

  return manager as {
    [K in T[number] as K["name"]]: CollectionCrud<K["$inferSelect"], K["$inferInsert"]>;
  } & {
    withNamespace: (namespace: string) => {
      [K in T[number] as K["name"]]: ScopedCollectionCrud<K["$inferSelect"], K["$inferInsert"]>;
    };
    getCollectionNames: () => string[];
    hasCollection: (name: string) => boolean;
  };
}

// ============================================
// INDEX GENERATION
// ============================================

/**
 * Generates SQL for creating indexes on collection fields.
 * 
 * @param definition - Collection definition
 * @returns Array of SQL statements for creating indexes
 */
export function generateCollectionIndexes(definition: CollectionDefinition): string[] {
  const { name, indexes } = definition;
  const statements: string[] = [];

  if (!indexes?.length) return statements;

  for (const indexDef of indexes) {
    let indexName: string;
    let indexSql: string;

    if (typeof indexDef === "string") {
      // Simple field index
      indexName = `idx_${name}_${indexDef}`;
      indexSql = `CREATE INDEX IF NOT EXISTS "${indexName}" 
        ON "nodes" (("data"->>'${indexDef}')) 
        WHERE "type" = '${name}'`;
    } else if (Array.isArray(indexDef)) {
      // Composite index
      indexName = `idx_${name}_${indexDef.join("_")}`;
      const columns = indexDef.map((f) => `("data"->>'${f}')`).join(", ");
      indexSql = `CREATE INDEX IF NOT EXISTS "${indexName}" 
        ON "nodes" (${columns}) 
        WHERE "type" = '${name}'`;
    } else {
      // Complex index definition
      const fields = Array.isArray(indexDef.fields)
        ? indexDef.fields
        : [indexDef.fields];
      indexName = `idx_${name}_${fields.join("_")}`;

      const indexType = indexDef.type ?? "btree";
      const unique = indexDef.unique ? "UNIQUE" : "";

      if (indexType === "gin") {
        const column = `("data"->'${fields[0]}')`;
        indexSql = `CREATE ${unique} INDEX IF NOT EXISTS "${indexName}" 
          ON "nodes" USING gin (${column}) 
          WHERE "type" = '${name}'`;
      } else if (indexType === "gist") {
        const column = `("data"->>'${fields[0]}')`;
        indexSql = `CREATE ${unique} INDEX IF NOT EXISTS "${indexName}" 
          ON "nodes" USING gist (${column} gist_trgm_ops) 
          WHERE "type" = '${name}'`;
      } else {
        const columns = fields.map((f) => `("data"->>'${f}')`).join(", ");
        let whereClause = `WHERE "type" = '${name}'`;

        if (indexDef.where) {
          const conditions = Object.entries(indexDef.where)
            .map(([k, v]) => `"data"->>'${k}' = '${v}'`)
            .join(" AND ");
          whereClause += ` AND ${conditions}`;
        }

        indexSql = `CREATE ${unique} INDEX IF NOT EXISTS "${indexName}" 
          ON "nodes" (${columns}) 
          ${whereClause}`;
      }
    }

    statements.push(indexSql);
  }

  return statements;
}

/**
 * Creates indexes for all collections.
 * 
 * @param db - Database instance
 * @param definitions - Array of collection definitions
 */
export async function createCollectionIndexes(
  db: DbInstance,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    const statements = generateCollectionIndexes(definition);
    for (const sql of statements) {
      try {
        await db.query(sql);
      } catch (error) {
        console.warn(`Failed to create index for ${definition.name}:`, error);
      }
    }
  }
}

