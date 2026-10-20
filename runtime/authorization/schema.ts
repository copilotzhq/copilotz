/** Version 12 owner-local authority records; no startup data conversion. */
export function authorizationSchemaStatements(
  schema: string,
): readonly string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new TypeError("Invalid schema name.");
  }
  const prefix = `"${schema}"`;
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}.authorization_sessions (
      namespace TEXT NOT NULL, tenant TEXT NOT NULL, id TEXT NOT NULL,
      principal TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ, PRIMARY KEY(namespace,tenant,id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}.authorization_channels (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, tenant TEXT NOT NULL,
      authority JSONB NOT NULL, dependencies JSONB NOT NULL,
      owner_epoch BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}.authorization_invocations (
      namespace TEXT NOT NULL, run_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
      authority JSONB NOT NULL, capture JSONB, inventory_digest TEXT,
      PRIMARY KEY(namespace,run_id)
    )`,
  ];
}
export const AUTHORIZATION_SCHEMA_COLUMNS = {
  authorization_sessions: [
    "namespace",
    "tenant",
    "id",
    "principal",
    "expires_at",
    "revoked_at",
  ],
  authorization_channels: [
    "id",
    "namespace",
    "tenant",
    "authority",
    "dependencies",
    "owner_epoch",
  ],
  authorization_invocations: [
    "namespace",
    "run_id",
    "source_event_id",
    "authority",
    "capture",
    "inventory_digest",
  ],
} as const;
