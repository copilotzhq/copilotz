import { Ominipg, type OminipgConnectionOptions } from "omnipg";
import { resolveAutoProviders } from "omnipg/auto";
import type { OminipgSessionTransport } from "omnipg/session";
import { DatabaseSession } from "./session.ts";
import {
  quoteIdentifier,
  v2BaselineSql,
  validateSchemaName,
} from "./v2-schema.ts";

export interface DatabaseConfig extends
  Omit<
    OminipgConnectionOptions,
    "schemas" | "schemaSQL" | "oxian" | "useWorker"
  > {
  /** Tenant PostgreSQL schema used by this engine. */
  schema?: string;
  /** App-owned shared WorkerHost or Hypervisor-backed dispatcher. */
  oxian?: OminipgSessionTransport;
  /** Existing app-owned Ominipg session. Copilotz will not close it. */
  instance?: Ominipg;
}

export interface CopilotzDatabase {
  readonly session: DatabaseSession;
  readonly schema: string;
  readonly instance: Ominipg;
  readonly owned: boolean;
  close(): Promise<void>;
}

export class LegacyDatabaseError extends Error {
  override name = "LegacyDatabaseError";

  constructor(schema: string) {
    super(
      `Schema '${schema}' contains a Copilotz v1 event queue. ` +
        "Drain active work and run the explicit v1 upgrade before starting Copilotz v2.",
    );
  }
}

export async function prepareV2Schema(
  session: DatabaseSession,
  schemaName = "public",
): Promise<void> {
  const validated = validateSchemaName(schemaName);
  const columns = await session.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'events'`,
    [validated],
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  if (
    names.size > 0 &&
    (!names.has("position") || names.has("event_type") || names.has("status"))
  ) {
    throw new LegacyDatabaseError(validated);
  }
  for (const statement of v2BaselineSql(validated)) {
    await session.query(statement);
  }
}

export async function createDatabase(
  config: DatabaseConfig = {},
): Promise<CopilotzDatabase> {
  const schema = validateSchemaName(config.schema ?? "public");
  const owned = !config.instance;
  const {
    schema: _schema,
    instance: configuredInstance,
    oxian,
    ...connection
  } = config;
  const instance = configuredInstance ?? await Ominipg.connect({
    ...connection,
    ...resolveAutoProviders(connection),
    oxian,
  });
  const session = new DatabaseSession(instance);
  try {
    await prepareV2Schema(session, schema);
  } catch (error) {
    if (owned) await session.close().catch(() => undefined);
    throw error;
  }
  return {
    session,
    schema,
    instance,
    owned,
    close: () => owned ? session.close() : Promise.resolve(),
  };
}

export async function schemaExists(
  database: CopilotzDatabase,
  schemaName: string,
): Promise<boolean> {
  const result = await database.session.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
    ) AS exists`,
    [validateSchemaName(schemaName)],
  );
  return result.rows[0]?.exists === true;
}

export async function provisionSchema(
  database: CopilotzDatabase,
  schemaName: string,
): Promise<void> {
  await prepareV2Schema(database.session, schemaName);
}

export async function listSchemas(
  database: CopilotzDatabase,
): Promise<readonly string[]> {
  const result = await database.session.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
       AND schema_name NOT LIKE 'pg_toast%'
     ORDER BY schema_name`,
  );
  return result.rows.map((row) => row.schema_name);
}

/** Internal helper used only by the isolated upgrade module. */
export function qualifiedTable(schemaName: string, table: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`;
}
