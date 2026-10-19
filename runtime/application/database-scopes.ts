import { validateEventSchemaName } from "../events/schema.ts";
function schema(value: unknown): string {
  const name = text(value, "Database schema");
  // PostgreSQL truncates longer identifiers, which would alias fixed scopes.
  if (name.length > 63) {
    throw new TypeError("Database schema exceeds 63 characters.");
  }
  return validateEventSchemaName(name);
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError(
      `${name} must be a non-empty bounded string without surrounding whitespace.`,
    );
  }
  return value;
}

/** The same explicit-scope validator is used before opening any persistence. */
export function hostDatabaseScopes(
  scopes: readonly string[] | undefined,
): readonly string[] {
  if (scopes !== undefined && !Array.isArray(scopes)) {
    throw new TypeError("databaseScopes must be an array.");
  }
  const result = new Set<string>();
  for (const requested of scopes ?? []) result.add(schema(requested));
  return Object.freeze([...result]);
}
