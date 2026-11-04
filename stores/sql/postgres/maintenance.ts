/**
 * Maintenance SQL's connection to a PostgreSQL server, and what it may
 * reach (runtime/maintain.ts; the store's `inspect` and `execute`).
 *
 * - **A connection of its own for each statement, closed after:** whatever
 *   the statement leaves on its session (a setting, a session lock, a
 *   prepared statement, a cursor) goes with it, and never reaches the
 *   connections the store and other tenants share. It speaks `pg` itself,
 *   the driver Ominipg loads, so every query goes over the extended
 *   protocol, where the server refuses more than one statement in a query.
 * - **As a role of its own** when the store names one
 *   (`postgresStore({ maintenance: { url } })`), else as the store's.
 * - **Only where nothing else is in reach** (`reach`): no other schema's
 *   tables, and no `dblink` or `postgres_fdw` in the database. A role of
 *   its own also may not be a superuser, hold a predefined role that
 *   reaches beyond the database's rows (`pg_signal_backend`,
 *   `pg_read_server_files`…), be a member of the store's role, or update,
 *   delete or truncate the log (`events`). Each is checked before every
 *   statement, on the connection that runs it.
 */
import { failure } from "../../../runtime/errors.ts";
import { ident, type Row, type Session } from "./layout.ts";

/** Not literal, so no bundler resolves it where only PGlite is used. */
const PG = "pg";

type Client = {
  connect(): Promise<void>;
  query(config: { text: string; values: unknown[]; queryMode: "extended" }): Promise<{
    rows: Row[];
  }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
};
type Driver = {
  Client: new (config: { connectionString: string; application_name: string }) => Client;
};

let driver: Promise<Driver> | undefined;

/** Bytes as plain `Uint8Array`s (`pg` gives Buffers, whose `toJSON` says something else). */
const plain = (row: Row): Row => {
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array && value.constructor !== Uint8Array) {
      row[key] = new Uint8Array(value);
    }
  }
  return row;
};

/** A new connection for one maintenance statement: a `Session`, and `end` to close it. */
export async function connect(
  url: string,
  trace?: (sql: string) => void,
): Promise<Session & { end(): Promise<void> }> {
  const pg = await (driver ??= import(PG).then((m) => (m.default ?? m) as Driver));
  const client = new pg.Client({ connectionString: url, application_name: "copilotz maintenance" });
  // A connection the server drops fails the query running on it: nothing else to say.
  client.on("error", () => {});
  await client.connect();
  return {
    async query(text, params = []) {
      trace?.(text);
      const { rows } = await client.query({ text, values: params, queryMode: "extended" });
      return { rows: rows.map(plain) };
    },
    end: () => client.end().catch(() => {}),
  };
}

/** Predefined roles that reach past a database's rows. */
const POWERS = [
  "pg_signal_backend",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_read_all_data",
  "pg_write_all_data",
];

const unsafe = (message: string) => failure("unsafe_role", message);

/**
 * Refuses maintenance SQL on `db` when its role reaches beyond `schema`
 * (see above). `store` is the store's own role; `own` says the connection
 * is a role of its own, which must also be least privilege.
 */
export async function reach(
  db: Session,
  schema: string,
  options: { own: boolean; store: string },
): Promise<void> {
  const [found] = (await db.query(
    `SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) ` +
      `AS super, (SELECT array_agg(n.nspname::text ORDER BY n.nspname) FROM pg_namespace n WHERE ` +
      `n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND ` +
      `n.nspname NOT LIKE 'pg\\_%' AND has_schema_privilege(n.oid, 'USAGE') AND EXISTS (SELECT ` +
      `1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ` +
      `AND has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'))) AS others, ` +
      `(SELECT array_agg(extname::text ORDER BY extname) FROM pg_extension WHERE extname IN ` +
      `('dblink', 'postgres_fdw')) AS remote, (SELECT array_agg(rolname::text ORDER BY rolname) FROM ` +
      `pg_roles WHERE rolname = ANY ($2::text[]) AND pg_has_role(current_user, oid, 'MEMBER')) ` +
      `AS powers, pg_has_role(current_user, $3::name, 'MEMBER') AS member, has_table_privilege($4::text, ` +
      `'UPDATE, DELETE, TRUNCATE') AS rewrites`,
    [schema, POWERS, options.store, `${ident(schema)}.events`],
  )).rows;
  const names = (value: unknown) => (value as string[] | null) ?? [];
  if (names(found.others).length) {
    throw unsafe(
      `SQL here would reach other schemas (${names(found.others).join(", ")}): give maintenance ` +
        `a role of its own, with privileges on "${schema}" only (postgresStore({ maintenance: ` +
        `{ url } }); see the README's Maintenance).`,
    );
  }
  if (names(found.remote).length) {
    throw unsafe(
      `SQL here could reach other databases (${names(found.remote).join(", ")} is installed).`,
    );
  }
  if (!options.own || found.role === options.store) return;
  const too = [
    ...(found.super ? ["is a superuser"] : []),
    ...names(found.powers).map((role) => `is a member of ${role}`),
    ...(found.member ? [`is a member of the store's role, ${options.store}`] : []),
    ...(found.rewrites ? ["may update, delete or truncate the log (events)"] : []),
  ];
  if (too.length) {
    throw unsafe(
      `The maintenance role ${found.role} ${too.join(", ")}: it must reach "${schema}" only ` +
        `(see the README's Maintenance).`,
    );
  }
}
