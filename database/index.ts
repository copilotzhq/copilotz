/**
 * Database module for Copilotz.
 * 
 * Provides database connectivity using Ominipg with support for PostgreSQL 
 * and PGlite (in-memory/file-based). Includes schema definitions, migrations,
 * and high-level database operations.
 * 
 * @module
 */

import { Ominipg } from "omnipg";
import type { OminipgWithCrud } from "omnipg";

import { splitSQLStatements } from "./migrations/utils.ts";
import { schema as baseSchema } from "./schemas/index.ts";
import { createOperations, type DatabaseOperations } from "./operations/index.ts";
import { generateMigrations } from "./migrations/migration_0001.ts";
import { generateRagMigrations } from "./migrations/migration_0002_rag.ts";
import { generateKnowledgeGraphMigrations } from "./migrations/migration_0003_knowledge_graph.ts";
import { generateUlidSupportMigrations } from "./migrations/migration_0004_ulid_support.ts";
import { generateNamespaceEventsMigrations } from "./migrations/migration_0005_namespace_events.ts";

/** SQL migration statements for setting up the database schema. */
const migrations: string = generateMigrations() + "\n" + generateRagMigrations() + "\n" + generateKnowledgeGraphMigrations() + "\n" + generateUlidSupportMigrations() + "\n" + generateNamespaceEventsMigrations();

/**
 * Configuration options for creating a database connection.
 * 
 * @example
 * ```ts
 * // In-memory database (default)
 * const db = await createDatabase();
 * 
 * // File-based PGlite database
 * const db = await createDatabase({ url: "file:./data.db" });
 * 
 * // PostgreSQL connection
 * const db = await createDatabase({ url: "postgres://user:pass@host:5432/db" });
 * ```
 */
export interface DatabaseConfig {
  /** 
   * Database connection URL. 
   * - `:memory:` for in-memory PGlite (default)
   * - `file:./path` for file-based PGlite
   * - `postgres://...` for PostgreSQL
   */
  url?: string;
  /** Optional sync URL for database replication. */
  syncUrl?: string;
  /** PGlite extensions to load. Default: ["uuid_ossp", "pg_trgm", "vector"]. */
  pgliteExtensions?: string[];
  /** Additional SQL statements to run during initialization. */
  schemaSQL?: string[];
  /** Whether to use a web worker for PGlite. Default: false. */
  useWorker?: boolean;
  /** Whether to log database performance metrics. */
  logMetrics?: boolean;
  /** Custom schema definitions. */
  schemas?: typeof baseSchema;
}


type Operations = DatabaseOperations;

/**
 * Low-level database instance type from Ominipg with CRUD operations.
 */
export type DbInstance = OminipgWithCrud<typeof baseSchema>;

/**
 * Copilotz database instance with CRUD operations and high-level ops.
 * This is the main database type used throughout Copilotz.
 */
export type CopilotzDb = DbInstance & { ops: Operations };

function getEnvVar(key: string): string | undefined {
  try {
    const anyGlobal = globalThis as unknown as {
      Deno?: { env?: { get?: (k: string) => string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };
    const fromDeno = anyGlobal?.Deno?.env?.get?.(key);
    if (typeof fromDeno === "string") return fromDeno;
    const fromNode = anyGlobal?.process?.env?.[key];
    if (typeof fromNode === "string") return fromNode;
  } catch {
    // ignore
  }
  return undefined;
}

const createDbInstance = async (
  finalConfig: DatabaseConfig,
  debug: boolean,
  cacheKey: string,
): Promise<CopilotzDb> => {
  if (debug) console.log(`[db] creating Ominipg: ${cacheKey}`);
  const schemas = finalConfig.schemas ?? baseSchema;

  const dbInstance = await Ominipg.connect({
    url: finalConfig.url,
    syncUrl: finalConfig.syncUrl,
    schemas,
    pgliteExtensions: finalConfig.pgliteExtensions,
    schemaSQL: finalConfig.schemaSQL,
    useWorker: finalConfig.useWorker,
    logMetrics: finalConfig.logMetrics,
  });

  const ops = createOperations(dbInstance);

  return Object.assign(dbInstance, { ops }) as CopilotzDb;
};

interface Connect {
  (
    finalConfig: DatabaseConfig,
    debug: boolean,
    cacheKey: string,
  ): Promise<CopilotzDb>;
}

const connect: Connect = async (
  finalConfig: DatabaseConfig,
  debug: boolean,
  cacheKey: string,
) => {
  if (debug) console.log(`[db] connecting Ominipg: ${cacheKey}`);

  // Create the database instance
  const dbInstance = await createDbInstance(finalConfig, debug, cacheKey);
  return dbInstance;
};

const GLOBAL_CACHE_KEY = "__copilotz_db_cache__";
const existingCache =
  (globalThis as Record<string, unknown>)[GLOBAL_CACHE_KEY] as
    | Map<string, Promise<CopilotzDb>>
    | undefined;
const globalCache: Map<string, Promise<CopilotzDb>> = existingCache ??
  new Map();
(globalThis as Record<string, unknown>)[GLOBAL_CACHE_KEY] = globalCache;

/**
 * Creates or retrieves a database connection for Copilotz.
 * 
 * This function manages a global connection cache, so calling it multiple times
 * with the same configuration will return the same database instance.
 * 
 * @param config - Optional database configuration. Defaults to in-memory PGlite.
 * @returns Promise resolving to a CopilotzDb instance
 * 
 * @example
 * ```ts
 * // Create an in-memory database
 * const db = await createDatabase();
 * 
 * // Create a file-based database
 * const db = await createDatabase({ url: "file:./my-data.db" });
 * 
 * // Connect to PostgreSQL
 * const db = await createDatabase({ 
 *   url: process.env.DATABASE_URL 
 * });
 * 
 * // Use the database
 * const threads = await db.ops.getAllThreads();
 * ```
 */
export async function createDatabase(
  config?: DatabaseConfig,
): Promise<CopilotzDb> {
  const isPgLite = !config?.url || config?.url.startsWith(":") ||
    config?.url.startsWith("file:") || config?.url.startsWith("pglite:");

  const url = config?.url || getEnvVar("DATABASE_URL") || ":memory:";

  console.log('migrations', JSON.stringify([...config?.schemaSQL || [], ...splitSQLStatements(migrations)])); 

  const finalConfig: DatabaseConfig = {
    url,
    syncUrl: config?.syncUrl || getEnvVar("SYNC_DATABASE_URL"),
    pgliteExtensions: isPgLite
      ? config?.pgliteExtensions || ["uuid_ossp", "pg_trgm", "vector"]
      : [],
    schemaSQL: [...config?.schemaSQL || [], ...splitSQLStatements(migrations)],
    useWorker: isPgLite ? config?.useWorker || false : false,
    logMetrics: config?.logMetrics,
    schemas: config?.schemas,
  };

  const cacheKey = `${finalConfig.url}|${finalConfig.syncUrl || ""}`;
  const debug = getEnvVar("COPILOTZ_DB_DEBUG") === "1";
  if (debug) {
    console.log(
      `[db] createDatabase requested: ${cacheKey} ${
        globalCache.has(cacheKey) ? "[cache-hit]" : "[cache-miss]"
      }`,
    );
  }
  if (globalCache.has(cacheKey)) {
    return await globalCache.get(cacheKey)!;
  }

  const connectPromise: Promise<CopilotzDb> = connect(
    finalConfig,
    debug,
    cacheKey,
  );

  globalCache.set(cacheKey, connectPromise);
  return await connectPromise;
}

/** Database schema definitions for all Copilotz entities. */
export { baseSchema as schema };

/** SQL migration statements for setting up the database schema. */
export { migrations };

// ============================================
// COLLECTIONS API
// ============================================

/** 
 * Collections API for defining and working with custom data collections.
 * Collections map to the graph structure (nodes + edges) with a developer-friendly interface.
 */
export {
  defineCollection,
  createCollectionsManager,
  createScopedCollections,
  createCollectionCrud,
  relation,
  index,
} from "./collections/index.ts";

export {
  generateCollectionIndexes,
  createCollectionIndexes,
} from "./collections/manager.ts";

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
} from "./collections/index.ts";
