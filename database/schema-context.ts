/**
 * Schema context module for multi-tenant PostgreSQL schema isolation.
 * 
 * Uses AsyncLocalStorage to propagate schema context through async operations
 * without explicitly passing it through every function call.
 * 
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance for storing the current schema context.
 * This allows schema to be implicitly available throughout an async call chain.
 */
const schemaStorage = new AsyncLocalStorage<string>();

/**
 * Gets the current schema from the async context.
 * 
 * @returns The current schema name, or undefined if not set
 * 
 * @example
 * ```ts
 * const schema = getCurrentSchema();
 * if (schema) {
 *   console.log(`Operating in schema: ${schema}`);
 * }
 * ```
 */
export function getCurrentSchema(): string | undefined {
  return schemaStorage.getStore();
}

/**
 * Executes a function within a specific schema context.
 * All database operations within the callback will use the specified schema.
 * 
 * @param schema - The PostgreSQL schema name to use
 * @param fn - The async function to execute within the schema context
 * @returns The result of the function
 * 
 * @example
 * ```ts
 * const result = await withSchema('tenant_abc', async () => {
 *   // All DB operations here will use the 'tenant_abc' schema
 *   return await db.query('SELECT * FROM users');
 * });
 * ```
 */
export function withSchema<T>(
  schema: string,
  fn: () => Promise<T>
): Promise<T> {
  return schemaStorage.run(schema, fn);
}

/**
 * Checks if we're currently operating within a non-public schema context.
 * 
 * @returns true if a schema is set and it's not 'public'
 */
export function isInSchemaContext(): boolean {
  const schema = getCurrentSchema();
  return !!schema && schema !== 'public';
}
