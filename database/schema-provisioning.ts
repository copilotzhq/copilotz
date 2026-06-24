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
 * In-memory cache of schemas migrated by this process.
 * Used to avoid repeated idempotent DDL checks for hot tenant paths.
 */
const provisionedSchemas = new Set<string>();

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
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "pg_temp_1",
  "pg_toast_temp_1",
]);

const REQUIRED_TABLES = ["threads", "events", "nodes", "edges"] as const;

const REQUIRED_RUNTIME_COLUMNS = [
  {
    table: "events",
    column: "subjectType",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "subjectType" varchar(255)`,
  },
  {
    table: "events",
    column: "subjectId",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "subjectId" varchar(255)`,
  },
  {
    table: "events",
    column: "operation",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "operation" varchar(64)`,
  },
  {
    table: "events",
    column: "causationId",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "causationId" varchar(255)`,
  },
  {
    table: "events",
    column: "correlationId",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "correlationId" varchar(255)`,
  },
  {
    table: "events",
    column: "dedupeKey",
    sql:
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "dedupeKey" varchar(512)`,
  },
  {
    table: "events",
    column: "input",
    sql: `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "input" jsonb`,
  },
  {
    table: "events",
    column: "before",
    sql: `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "before" jsonb`,
  },
  {
    table: "events",
    column: "after",
    sql: `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "after" jsonb`,
  },
  {
    table: "events",
    column: "patch",
    sql: `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "patch" jsonb`,
  },
] as const;

const REQUIRED_RUNTIME_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_time"
     ON "nodes" ("namespace", "created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_agent_time"
     ON "nodes" ("namespace", ("data"->>'agentId'), "created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_initiator_time"
     ON "nodes" (
       "namespace",
       (COALESCE("data"->'runSender'->>'externalId', "data"->'runSender'->>'id', "data"->'runSender'->>'email', "data"->'runSender'->>'name', '')),
       "created_at"
     )
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_provider_time"
     ON "nodes" ("namespace", ("data"->>'provider'), "created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_model_time"
     ON "nodes" ("namespace", ("data"->>'model'), "created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_created_at"
     ON "nodes" ("created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_thread_time"
     ON "nodes" ("namespace", ("data"->>'threadId'), "created_at")
     WHERE "type" = 'llm_attempt'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_time"
     ON "nodes" ("namespace", "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_kind_time"
     ON "nodes" ("namespace", ("data"->>'kind'), "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_agent_time"
     ON "nodes" ("namespace", ("data"->>'agentId'), "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_initiator_time"
     ON "nodes" ("namespace", ("data"->>'initiatedById'), "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_provider_time"
     ON "nodes" ("namespace", ("data"->>'provider'), "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_model_time"
     ON "nodes" ("namespace", ("data"->>'model'), "created_at")
     WHERE "type" = 'usage'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_usage_thread_time"
     ON "nodes" ("namespace", ("data"->>'threadId'), "created_at")
     WHERE "type" = 'usage'`,
] as const;

const provisioningPromises = new Map<string, Promise<void>>();

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
  if (!schemaName || typeof schemaName !== "string") {
    throw new Error("Schema name must be a non-empty string");
  }

  if (schemaName.length > 63) {
    throw new Error(
      `Schema name too long: max 63 characters, got ${schemaName.length}`,
    );
  }

  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new Error(
      `Invalid schema name: "${schemaName}". ` +
        `Must start with letter or underscore, contain only alphanumeric characters and underscores.`,
    );
  }

  // Check for reserved names (case-insensitive)
  const lowerName = schemaName.toLowerCase();
  if (RESERVED_SCHEMAS.has(lowerName) || lowerName.startsWith("pg_")) {
    throw new Error(
      `Schema name "${schemaName}" is reserved and cannot be used`,
    );
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
  schemaName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM information_schema.schemata 
      WHERE schema_name = $1
    ) as exists`,
    [schemaName],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Checks whether a tenant schema has the core Copilotz tables.
 *
 * A schema can exist but be empty if it was pre-created manually or by infra.
 * Such a schema is not provisioned and must still receive migrations.
 */
export async function schemaIsProvisioned(
  db: DbInstance,
  schemaName: string,
): Promise<boolean> {
  if (schemaName !== "public") {
    validateSchemaName(schemaName);
  }

  const result = await db.query<{ table_count: number | string }>(
    `SELECT COUNT(DISTINCT table_name) AS table_count
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name = ANY($2::text[])`,
    [schemaName, [...REQUIRED_TABLES]],
  );
  const count = Number(result.rows[0]?.table_count ?? 0);
  return count === REQUIRED_TABLES.length;
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
  schemaName: string,
): Promise<void> {
  await migrateSchema(db, schemaName);
}

/**
 * Runs all current Copilotz schema migrations against a schema.
 *
 * Existing schemas from older Copilotz versions may already have the core
 * tables but miss additive columns/indexes from newer releases. This function
 * treats migrations as the source of truth and is intentionally idempotent.
 */
export async function migrateSchema(
  db: DbInstance,
  schemaName: string,
): Promise<void> {
  // Validate schema name (prevent SQL injection)
  // This is critical since schema names cannot be parameterized
  if (schemaName !== "public") {
    validateSchemaName(schemaName);

    // Create the schema if it doesn't exist
    await db.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`,
    );
  }

  // Run each migration statement inside a transaction with search_path pinned
  // to the tenant schema. In direct Postgres mode, this must use one checked-out
  // pool client so BEGIN, SET LOCAL, and the migration statement share a session.
  const statements = splitSQLStatements(migrations);

  for (const statement of statements) {
    if (!statement.trim()) continue;

    try {
      await executeInSchemaTransaction(db, schemaName, statement);
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      // Ignore "already exists" errors for idempotency
      // 42P07 = duplicate_table, 42710 = duplicate_object
      // 42P16 = invalid_table_definition (for constraints that already exist)
      if (
        pgErr.code === "42P07" ||
        pgErr.code === "42710" ||
        pgErr.message?.includes("already exists")
      ) {
        continue;
      }
      throw err;
    }
  }

  // Mark as provisioned
  provisionedSchemas.add(schemaName);
}

async function schemaHasColumn(
  db: DbInstance,
  schemaName: string,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
         AND column_name = $3
     ) AS "exists"`,
    [schemaName, tableName, columnName],
  );
  return result.rows[0]?.exists === true;
}

async function ensureRuntimeCompatibility(
  db: DbInstance,
  schemaName: string,
): Promise<void> {
  for (const column of REQUIRED_RUNTIME_COLUMNS) {
    if (await schemaHasColumn(db, schemaName, column.table, column.column)) {
      continue;
    }
    await executeInSchemaTransaction(db, schemaName, column.sql);
  }
  for (const statement of REQUIRED_RUNTIME_INDEXES) {
    await executeInSchemaTransaction(db, schemaName, statement);
  }
}

/**
 * Runs current Copilotz migrations against every non-system schema.
 */
export async function migrateAllSchemas(db: DbInstance): Promise<{
  schemas: string[];
}> {
  const schemas = await listTenantSchemas(db);
  for (const schemaName of schemas) {
    await migrateSchema(db, schemaName);
  }
  return { schemas };
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
  schemaName: string,
): Promise<void> {
  if (schemaName === "public") {
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
  schemaName: string,
): Promise<void> {
  // Always validate schema name first (defense in depth)
  // This is critical even for cached schemas to prevent injection
  if (schemaName !== "public") {
    validateSchemaName(schemaName);
  }

  // Fast path: this process already ran current migrations for the schema.
  if (provisionedSchemas.has(schemaName)) {
    return;
  }

  const existingProvisioning = provisioningPromises.get(schemaName);
  if (existingProvisioning) {
    await existingProvisioning;
    return;
  }

  const provisioning = (async () => {
    const hasCoreTables = await schemaIsProvisioned(db, schemaName);
    if (!hasCoreTables) {
      await provisionTenantSchema(db, schemaName);
      return;
    }

    await ensureRuntimeCompatibility(db, schemaName);
    provisionedSchemas.add(schemaName);
  })();

  provisioningPromises.set(schemaName, provisioning);
  try {
    await provisioning;
  } finally {
    provisioningPromises.delete(schemaName);
  }
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
     AND schema_name NOT LIKE 'pg_%'`,
  );

  for (const row of result.rows) {
    await ensureSchemaProvisioned(db, row.schema_name);
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
     ORDER BY schema_name`,
  );

  return result.rows.map((row) => row.schema_name);
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
  provisioningPromises.clear();
}

type DirectPoolClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  release: () => void;
};

function getDirectPool(db: DbInstance): {
  connect?: () => Promise<DirectPoolClient>;
} | undefined {
  return (db as unknown as {
    pool?: {
      connect?: () => Promise<DirectPoolClient>;
    };
  }).pool;
}

async function executeInSchemaTransaction(
  db: DbInstance,
  schemaName: string,
  statement: string,
): Promise<void> {
  const pool = getDirectPool(db);
  if (typeof pool?.connect === "function") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL search_path TO ${quoteIdentifier(schemaName)}, public`,
      );
      await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  try {
    await db.query("BEGIN");
    await db.query(
      `SET LOCAL search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    await db.query(statement);
    await db.query("COMMIT");
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  }
}

function quoteIdentifier(identifier: string): string {
  validateSchemaName(identifier);
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}
