/**
 * Schema provisioning module for multi-tenant PostgreSQL schema management.
 * 
 * Provides functions to create, check, and manage tenant schemas with
 * automatic migration support.
 * 
 * @module
 */

import type { DbInstance } from "./index.ts";
import { migrations } from "./index.ts";
import { splitSQLStatements } from "./migrations/utils.ts";

/**
 * In-memory cache of provisioned schemas.
 * Used to avoid repeated database checks for schema existence.
 */
const provisionedSchemas = new Set<string>();

// Always consider 'public' as provisioned
provisionedSchemas.add('public');

/**
 * Regex pattern for valid PostgreSQL schema names.
 * Must start with letter or underscore, followed by letters, numbers, or underscores.
 * Max length 63 characters (PostgreSQL identifier limit).
 */
const SCHEMA_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Reserved schema names that cannot be used for tenants.
 */
const RESERVED_SCHEMAS = new Set([
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'pg_temp_1',
  'pg_toast_temp_1',
]);

/**
 * Validates a schema name for security and PostgreSQL compatibility.
 * 
 * @param schemaName - The schema name to validate
 * @throws Error if the schema name is invalid or reserved
 * 
 * @remarks
 * This validation is critical for preventing SQL injection attacks
 * since schema names cannot be parameterized in PostgreSQL.
 */
export function validateSchemaName(schemaName: string): void {
  if (!schemaName || typeof schemaName !== 'string') {
    throw new Error('Schema name must be a non-empty string');
  }

  if (schemaName.length > 63) {
    throw new Error(`Schema name too long: max 63 characters, got ${schemaName.length}`);
  }

  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new Error(
      `Invalid schema name: "${schemaName}". ` +
      `Must start with letter or underscore, contain only alphanumeric characters and underscores.`
    );
  }

  // Check for reserved names (case-insensitive)
  const lowerName = schemaName.toLowerCase();
  if (RESERVED_SCHEMAS.has(lowerName) || lowerName.startsWith('pg_')) {
    throw new Error(`Schema name "${schemaName}" is reserved and cannot be used`);
  }
}

/**
 * Checks if a schema exists in the database.
 * 
 * @param db - Database instance
 * @param schemaName - Name of the schema to check
 * @returns true if the schema exists
 * 
 * @example
 * ```ts
 * if (await schemaExists(db, 'tenant_abc')) {
 *   console.log('Schema exists');
 * }
 * ```
 */
export async function schemaExists(
  db: DbInstance,
  schemaName: string
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM information_schema.schemata 
      WHERE schema_name = $1
    ) as exists`,
    [schemaName]
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Creates a new tenant schema and runs all migrations.
 * This sets up the complete database structure for a new tenant.
 * 
 * @param db - Database instance
 * @param schemaName - Name of the schema to create
 * @throws Error if schema creation or migration fails
 * 
 * @example
 * ```ts
 * await provisionTenantSchema(db, 'tenant_abc');
 * // Schema 'tenant_abc' now has all tables ready
 * ```
 */
export async function provisionTenantSchema(
  db: DbInstance,
  schemaName: string
): Promise<void> {
  if (schemaName === 'public') {
    // Public schema should already be provisioned via normal migration
    provisionedSchemas.add('public');
    return;
  }

  // Validate schema name (prevent SQL injection)
  // This is critical since schema names cannot be parameterized
  validateSchemaName(schemaName);

  // Create the schema if it doesn't exist
  await db.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // Run migrations in the new schema
  // We need to set search_path for each statement since we're not in a transaction
  const statements = splitSQLStatements(migrations);
  
  for (const statement of statements) {
    if (!statement.trim()) continue;
    
    try {
      // Prefix each statement with search_path setting
      await db.query(`SET LOCAL search_path TO "${schemaName}", public`);
      await db.query(statement);
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      // Ignore "already exists" errors for idempotency
      // 42P07 = duplicate_table, 42710 = duplicate_object
      // 42P16 = invalid_table_definition (for constraints that already exist)
      if (
        pgErr.code === '42P07' || 
        pgErr.code === '42710' ||
        pgErr.message?.includes('already exists')
      ) {
        continue;
      }
      throw err;
    }
  }

  // Mark as provisioned
  provisionedSchemas.add(schemaName);
}

/**
 * Drops a tenant schema and all its data.
 * WARNING: This permanently deletes all data in the schema!
 * 
 * @param db - Database instance
 * @param schemaName - Name of the schema to drop
 * @throws Error if attempting to drop 'public' schema
 * 
 * @example
 * ```ts
 * await dropTenantSchema(db, 'tenant_abc');
 * // Schema and all its data are now deleted
 * ```
 */
export async function dropTenantSchema(
  db: DbInstance,
  schemaName: string
): Promise<void> {
  if (schemaName === 'public') {
    throw new Error("Cannot drop public schema");
  }

  // Validate schema name (prevent SQL injection)
  validateSchemaName(schemaName);

  await db.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  provisionedSchemas.delete(schemaName);
}

/**
 * Ensures a schema is provisioned, creating it if necessary.
 * Uses in-memory caching to avoid repeated database checks.
 * 
 * @param db - Database instance
 * @param schemaName - Name of the schema to ensure exists
 * 
 * @example
 * ```ts
 * await ensureSchemaProvisioned(db, 'tenant_abc');
 * // Safe to use schema now
 * ```
 */
export async function ensureSchemaProvisioned(
  db: DbInstance,
  schemaName: string
): Promise<void> {
  // Always validate schema name first (defense in depth)
  // This is critical even for cached schemas to prevent injection
  if (schemaName !== 'public') {
    validateSchemaName(schemaName);
  }

  // Fast path: already in cache
  if (provisionedSchemas.has(schemaName)) {
    return;
  }

  // Check if schema exists in database
  const exists = await schemaExists(db, schemaName);
  
  if (exists) {
    // Schema exists, just add to cache
    provisionedSchemas.add(schemaName);
    return;
  }

  // Schema doesn't exist, provision it
  await provisionTenantSchema(db, schemaName);
}

/**
 * Warms the schema cache by loading all existing schemas from the database.
 * Call this during application startup to avoid first-request latency.
 * 
 * @param db - Database instance
 * 
 * @example
 * ```ts
 * const db = await createDatabase(config);
 * await warmSchemaCache(db);
 * // All existing schemas are now cached
 * ```
 */
export async function warmSchemaCache(db: DbInstance): Promise<void> {
  const result = await db.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata 
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
     AND schema_name NOT LIKE 'pg_%'`
  );
  
  for (const row of result.rows) {
    provisionedSchemas.add(row.schema_name);
  }
}

/**
 * Lists all tenant schemas (excludes system schemas).
 * 
 * @param db - Database instance
 * @returns Array of schema names
 * 
 * @example
 * ```ts
 * const schemas = await listTenantSchemas(db);
 * // ['public', 'tenant_abc', 'tenant_xyz']
 * ```
 */
export async function listTenantSchemas(db: DbInstance): Promise<string[]> {
  const result = await db.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata 
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND schema_name NOT LIKE 'pg_%'
     ORDER BY schema_name`
  );
  
  return result.rows.map(row => row.schema_name);
}

/**
 * Checks if a schema is in the provisioned cache.
 * Does NOT check the database - use schemaExists() for that.
 * 
 * @param schemaName - Name of the schema to check
 * @returns true if schema is in the cache
 */
export function isSchemaInCache(schemaName: string): boolean {
  return provisionedSchemas.has(schemaName);
}

/**
 * Clears the provisioned schemas cache.
 * Useful for testing or when schemas are modified externally.
 */
export function clearSchemaCache(): void {
  provisionedSchemas.clear();
  provisionedSchemas.add('public');
}
