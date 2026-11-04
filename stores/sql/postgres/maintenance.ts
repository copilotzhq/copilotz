/**
 * Maintenance SQL's connection to a PostgreSQL server, and the role it runs
 * as (runtime/maintain.ts; the store's `inspect` and `execute`).
 *
 * - **A role of its own, required on a server**
 *   (`postgresStore({ maintenance: { url } })`): the store's own role owns
 *   the tables, may stop the app's connections, and is whatever the
 *   deployment made it (a superuser, even). Without one, raw SQL is
 *   refused; the collections' operations, named queries and blobs don't
 *   need it. PGlite, in this process, runs it as its one session.
 * - **Exactly the grants maintenance needs, checked before every
 *   statement** (`allowed`), on the connection that runs it: an allowlist,
 *   not a list of what's refused. The role has no attribute beyond LOGIN,
 *   is a member of no role at all (so `SET ROLE` reaches nothing, whatever
 *   INHERIT says), owns nothing, may create nothing anywhere, and holds no
 *   privilege on any table or column outside the store's schema; inside
 *   it, SELECT on everything, INSERT, UPDATE and DELETE on documents,
 *   edges, vectors and blobs, INSERT on the log, UPDATE of meta's `value`
 *   (to hold the fence), and nothing more. It may run no SECURITY DEFINER
 *   function (one runs as its owner: revoke EXECUTE from PUBLIC), and the
 *   database has no `dblink` or `postgres_fdw`. The store makes no
 *   triggers: one on its tables means someone else did, and nothing runs.
 * - **A connection of its own for each statement, closed after:** whatever
 *   the statement leaves on its session goes with it. It speaks `pg`
 *   itself, the driver Ominipg loads, so every query goes over the
 *   extended protocol, where the server refuses more than one statement.
 * - **At most `connections` at once** (2 by default; ../shared/capped.ts).
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

const unsafe = (message: string) => failure("unsafe_role", message);

/** Refuses raw SQL on a server whose store names no maintenance role. */
export const noRole = () =>
  unsafe(
    "Raw SQL on a PostgreSQL server runs only as a maintenance role of its own: " +
      "postgresStore({ maintenance: { url } }), set up as the README's Maintenance says. " +
      "The collections' operations, named queries and blobs work without it.",
  );

/**
 * What the role on `db` holds beyond the allowlist above, for `schema`: one
 * line for each, none when it holds exactly that.
 */
const BEYOND = `
WITH me AS (
  SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
  FROM pg_roles WHERE rolname = current_user
), own AS (
  SELECT oid FROM pg_namespace WHERE nspname = $1::name
), catalogs AS (
  SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')
), privileges AS (
  SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || CASE WHEN current_setting('server_version_num')::int >= 170000
       THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) AS privilege
), extension AS (
  SELECT objid FROM pg_depend WHERE deptype = 'e' AND classid = 'pg_class'::regclass
)
SELECT problem FROM (
  SELECT 'is a superuser' AS problem FROM me WHERE rolsuper
  UNION ALL SELECT 'may create roles' FROM me WHERE rolcreaterole
  UNION ALL SELECT 'may create databases' FROM me WHERE rolcreatedb
  UNION ALL SELECT 'may replicate' FROM me WHERE rolreplication
  UNION ALL SELECT 'bypasses row security' FROM me WHERE rolbypassrls
  UNION ALL SELECT 'is a member of ' || r.rolname::text
    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid, me WHERE m.member = me.oid
  UNION ALL SELECT 'owns the database' FROM pg_database d, me
    WHERE d.datname = current_database() AND d.datdba = me.oid
  UNION ALL SELECT 'may create schemas' WHERE has_database_privilege(current_database(), 'CREATE')
  UNION ALL SELECT 'owns ' || c.oid::regclass::text FROM pg_class c, me WHERE c.relowner = me.oid
  UNION ALL SELECT 'owns schema ' || n.nspname::text FROM pg_namespace n, me
    WHERE n.nspowner = me.oid
  UNION ALL SELECT 'owns ' || p.oid::regprocedure::text FROM pg_proc p, me
    WHERE p.proowner = me.oid
  UNION ALL SELECT 'may create in schema ' || n.nspname::text FROM pg_namespace n
    WHERE has_schema_privilege(n.oid, 'CREATE')
  UNION ALL SELECT 'may use ' || c.oid::regclass::text FROM pg_class c
    WHERE c.relnamespace NOT IN (SELECT oid FROM own) AND c.relnamespace NOT IN
      (SELECT oid FROM catalogs) AND c.oid NOT IN (SELECT objid FROM extension)
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (has_table_privilege(c.oid, (SELECT string_agg(privilege, ', ') FROM privileges))
        OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
  UNION ALL SELECT 'may use sequence ' || c.oid::regclass::text FROM pg_class c
    WHERE c.relkind = 'S' AND c.relnamespace NOT IN (SELECT oid FROM catalogs)
      AND c.oid NOT IN (SELECT objid FROM extension)
      AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE, SELECT, UPDATE')
        ELSE false END
  UNION ALL SELECT 'may ' || p.privilege || ' ' || c.oid::regclass::text
    FROM pg_class c, privileges p
    WHERE c.relnamespace IN (SELECT oid FROM own) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND p.privilege <> 'SELECT' AND has_table_privilege(c.oid, p.privilege) AND NOT (
        (c.relname IN ('nodes', 'edges', 'vectors', 'blobs')
          AND p.privilege IN ('INSERT', 'UPDATE', 'DELETE'))
        OR (c.relname = 'events' AND p.privilege = 'INSERT'))
  UNION ALL SELECT 'may ' || p.privilege || ' ' || c.oid::regclass::text || '.' || a.attname
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid,
      (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
    WHERE c.relnamespace IN (SELECT oid FROM own) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege(c.oid, a.attnum, p.privilege) AND NOT (
        (c.relname IN ('nodes', 'edges', 'vectors', 'blobs')
          AND p.privilege IN ('INSERT', 'UPDATE'))
        OR (c.relname = 'events' AND p.privilege = 'INSERT')
        OR (c.relname = 'meta' AND a.attname = 'value' AND p.privilege = 'UPDATE'))
  UNION ALL SELECT 'may run ' || p.oid::regprocedure::text || ' as its owner (SECURITY DEFINER)'
    FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN (SELECT oid FROM catalogs)
      AND has_function_privilege(p.oid, 'EXECUTE')
  UNION ALL SELECT 'the database has ' || extname::text FROM pg_extension
    WHERE extname IN ('dblink', 'postgres_fdw')
  UNION ALL SELECT 'a trigger the store didn''t make: ' || t.tgname::text || ' on ' ||
      c.relname::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace IN (SELECT oid FROM own) AND NOT t.tgisinternal
) beyond ORDER BY problem`;

/** Refuses maintenance SQL when the role on `db` holds anything beyond the allowlist. */
export async function allowed(db: Session, schema: string): Promise<void> {
  const problems = (await db.query(BEYOND, [schema])).rows.map((row) => String(row.problem));
  if (!problems.length) return;
  const shown = problems.slice(0, 8).join("; ") +
    (problems.length > 8 ? `; and ${problems.length - 8} more` : "");
  throw unsafe(
    `The maintenance role holds more than maintenance needs: it ${shown}. It must hold the ` +
      `README's grants on "${schema}" and nothing else.`,
  );
}

/**
 * PGlite's check, its one session being the store's: no other schema's
 * tables within reach (another store's, in this process), and no remote
 * databases.
 */
export async function alone(db: Session, schema: string): Promise<void> {
  const [found] = (await db.query(
    `SELECT (SELECT array_agg(n.nspname::text ORDER BY n.nspname) FROM pg_namespace n WHERE ` +
      `n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND ` +
      `n.nspname NOT LIKE 'pg\\_%' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = ` +
      `n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))) AS others, (SELECT ` +
      `array_agg(extname::text) FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw')) ` +
      `AS remote`,
    [schema],
  )).rows;
  const names = (value: unknown) => (value as string[] | null) ?? [];
  if (names(found.others).length || names(found.remote).length) {
    throw unsafe(
      `SQL here would reach beyond "${schema}" (${
        [...names(found.others), ...names(found.remote)].join(", ")
      }).`,
    );
  }
}

/** Triggers on the store's tables: none of the store's making, so none at all. */
export const triggers = (schema: string) =>
  `(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE ` +
  `c.relnamespace = ${`'${ident(schema).replaceAll("'", "''")}'`}::regnamespace AND NOT ` +
  `t.tgisinternal)::int`;
