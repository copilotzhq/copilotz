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
 * Cloud SQL's markers of an IAM database user (a role made by `gcloud sql
 * users create … --type=cloud_iam_*`): such a role is a member of one. Every
 * IAM user is, so a marker is held to an empty allowlist (it may hold
 * nothing at all, not even on the store's schema), and the membership may
 * not carry ADMIN OPTION (the role could hand the marker to anyone).
 */
const MARKERS = ["cloudsqliamuser", "cloudsqliamserviceaccount", "cloudsqliamgroup"];

/**
 * What role `$2` holds beyond the allowlist above, for schema `$1`, one line
 * for each, none when it holds exactly that; `$3` are the roles it may be a
 * member of (Cloud SQL's markers). With no schema (`''`), the allowlist is
 * empty: anything at all granted to it is beyond it. Every catalog name is
 * `pg_catalog`'s: after a statement, in its transaction, a temporary table
 * could stand in for one.
 */
const BEYOND = `
WITH me AS (
  SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname = $2::pg_catalog.name
), own AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::pg_catalog.name
), here AS (
  SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
), catalogs AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')
), privileges AS (
  SELECT pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
    'TRIGGER'] || CASE WHEN pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >=
    170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::pg_catalog.text[] END) AS privilege
), temporary AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname ~ '^pg_(toast_)?temp_'
), extension AS (
  SELECT objid FROM pg_catalog.pg_depend
  WHERE deptype = 'e' AND classid = 'pg_catalog.pg_class'::pg_catalog.regclass
)
SELECT DISTINCT problem FROM (
  SELECT 'is a superuser' AS problem FROM me WHERE rolsuper
  UNION ALL SELECT 'may create roles' FROM me WHERE rolcreaterole
  UNION ALL SELECT 'may create databases' FROM me WHERE rolcreatedb
  UNION ALL SELECT 'may replicate' FROM me WHERE rolreplication
  UNION ALL SELECT 'bypasses row security' FROM me WHERE rolbypassrls
  UNION ALL SELECT 'is a member of ' || r.rolname::pg_catalog.text
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid, me
    WHERE m.member = me.oid AND r.rolname::pg_catalog.text <> ALL ($3::pg_catalog.text[])
  UNION ALL SELECT 'has settings of its own (' ||
      pg_catalog.array_to_string(s.setconfig, ', ') || ')'
    FROM pg_catalog.pg_db_role_setting s, me WHERE s.setrole = me.oid
  UNION ALL SELECT 'owns the database' FROM pg_catalog.pg_database d, me, here
    WHERE d.oid = here.oid AND d.datdba = me.oid
  UNION ALL SELECT 'may create schemas'
    WHERE pg_catalog.has_database_privilege($2::pg_catalog.name, pg_catalog.current_database(),
      'CREATE')
  UNION ALL SELECT 'owns ' || pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
    FROM pg_catalog.pg_shdepend d, me, here
    WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid = me.oid
      AND d.deptype = 'o' AND d.dbid IN (0, here.oid)
      -- What it made for this session alone goes with its connection, closed after.
      AND NOT (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid IN
        (SELECT oid FROM pg_catalog.pg_class WHERE relnamespace IN (SELECT oid FROM temporary)))
      AND NOT (d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid IN
        (SELECT oid FROM pg_catalog.pg_type WHERE typnamespace IN (SELECT oid FROM temporary)))
      AND NOT (d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid IN
        (SELECT oid FROM pg_catalog.pg_proc WHERE pronamespace IN (SELECT oid FROM temporary)))
  UNION ALL SELECT 'owns a database elsewhere' FROM pg_catalog.pg_shdepend d, me, here
    WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid = me.oid
      AND d.deptype = 'o' AND d.dbid NOT IN (0, here.oid)
  UNION ALL SELECT 'is granted something on ' ||
      pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
    FROM pg_catalog.pg_shdepend d, me, here
    WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid = me.oid
      AND d.deptype = 'a' AND d.dbid IN (0, here.oid) AND NOT (
        (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid IN
          (SELECT oid FROM pg_catalog.pg_class WHERE relnamespace IN (SELECT oid FROM own)))
        OR (d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          AND d.objid IN (SELECT oid FROM own))
        OR (d.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass AND d.objid IN
          (SELECT oid FROM pg_catalog.pg_default_acl WHERE defaclnamespace IN (SELECT oid FROM own)))
        OR (d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
          AND d.objid IN (SELECT oid FROM here) AND EXISTS (SELECT 1 FROM own)))
  UNION ALL SELECT 'owns large object ' || m.oid::pg_catalog.text
    FROM pg_catalog.pg_largeobject_metadata m, me WHERE m.lomowner = me.oid
  UNION ALL SELECT 'may read large object ' || m.oid::pg_catalog.text
    FROM pg_catalog.pg_largeobject_metadata m, me
    WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(m.lomacl) a WHERE a.grantee IN (0, me.oid))
  UNION ALL SELECT 'may read every large object (lo_compat_privileges)'
    WHERE pg_catalog.current_setting('lo_compat_privileges') = 'on'
  UNION ALL SELECT 'may create in schema ' || n.nspname::pg_catalog.text
    FROM pg_catalog.pg_namespace n
    WHERE pg_catalog.has_schema_privilege($2::pg_catalog.name, n.oid, 'CREATE')
      AND n.oid NOT IN (SELECT oid FROM temporary)
  UNION ALL SELECT 'may use ' || c.oid::pg_catalog.regclass::pg_catalog.text
    FROM pg_catalog.pg_class c
    WHERE c.relnamespace NOT IN (SELECT oid FROM own) AND c.relnamespace NOT IN
      (SELECT oid FROM catalogs) AND c.relnamespace NOT IN (SELECT oid FROM temporary)
      AND c.oid NOT IN (SELECT objid FROM extension) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (pg_catalog.has_table_privilege($2::pg_catalog.name, c.oid,
          (SELECT pg_catalog.string_agg(privilege, ', ') FROM privileges))
        OR pg_catalog.has_any_column_privilege($2::pg_catalog.name, c.oid,
          'SELECT, INSERT, UPDATE, REFERENCES'))
  UNION ALL SELECT 'may use sequence ' || c.oid::pg_catalog.regclass::pg_catalog.text
    FROM pg_catalog.pg_class c
    WHERE c.relkind = 'S' AND c.relnamespace NOT IN (SELECT oid FROM catalogs)
      AND c.relnamespace NOT IN (SELECT oid FROM temporary)
      AND c.oid NOT IN (SELECT objid FROM extension)
      AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege($2::pg_catalog.name,
        c.oid, 'USAGE, SELECT, UPDATE') ELSE false END
  UNION ALL SELECT 'may ' || p.privilege || ' ' || c.oid::pg_catalog.regclass::pg_catalog.text
    FROM pg_catalog.pg_class c, privileges p
    WHERE c.relnamespace IN (SELECT oid FROM own) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND p.privilege <> 'SELECT'
      AND pg_catalog.has_table_privilege($2::pg_catalog.name, c.oid, p.privilege) AND NOT (
        (c.relname IN ('nodes', 'edges', 'vectors', 'blobs')
          AND p.privilege IN ('INSERT', 'UPDATE', 'DELETE'))
        OR (c.relname = 'events' AND p.privilege = 'INSERT'))
  UNION ALL SELECT 'may ' || p.privilege || ' ' || c.oid::pg_catalog.regclass::pg_catalog.text ||
      '.' || a.attname::pg_catalog.text
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid,
      (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
    WHERE c.relnamespace IN (SELECT oid FROM own) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.has_column_privilege($2::pg_catalog.name, c.oid, a.attnum, p.privilege)
      AND NOT (
        (c.relname IN ('nodes', 'edges', 'vectors', 'blobs')
          AND p.privilege IN ('INSERT', 'UPDATE'))
        OR (c.relname = 'events' AND p.privilege = 'INSERT')
        OR (c.relname = 'meta' AND a.attname = 'value' AND p.privilege = 'UPDATE'))
  UNION ALL SELECT 'may run ' || p.oid::pg_catalog.regprocedure::pg_catalog.text ||
      ' as its owner (SECURITY DEFINER)'
    FROM pg_catalog.pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN (SELECT oid FROM catalogs)
      AND pg_catalog.has_function_privilege($2::pg_catalog.name, p.oid, 'EXECUTE')
  UNION ALL SELECT 'the database has ' || extname::pg_catalog.text FROM pg_catalog.pg_extension
    WHERE extname IN ('dblink', 'postgres_fdw')
  UNION ALL SELECT 'a trigger the store didn''t make: ' || t.tgname::pg_catalog.text || ' on ' ||
      c.relname::pg_catalog.text
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace IN (SELECT oid FROM own) AND NOT t.tgisinternal
) beyond ORDER BY problem`;

/**
 * Refuses maintenance SQL when the role on `db` (the session's own, the
 * login's), or a Cloud SQL marker it's a member of, holds anything beyond
 * the allowlist.
 */
export async function allowed(db: Session, schema: string): Promise<void> {
  const [{ role, markers, admin }] = (await db.query(
    `WITH mine AS (SELECT r.rolname::pg_catalog.text AS marker, m.admin_option FROM ` +
      `pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid WHERE ` +
      `m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user) AND ` +
      `r.rolname::pg_catalog.text = ANY ($1::pg_catalog.text[])) SELECT ` +
      `session_user::pg_catalog.text AS role, (SELECT pg_catalog.array_agg(marker) FROM mine) ` +
      `AS markers, (SELECT pg_catalog.array_agg(marker) FROM mine WHERE admin_option) AS admin`,
    [MARKERS],
  )).rows as { role: string; markers: string[] | null; admin: string[] | null }[];
  const problems = (admin ?? []).map((marker) =>
    `may grant ${marker} to others (ADMIN OPTION), and so every IAM user's reach`
  );
  // The role holds the allowlist; a marker, every IAM user's, holds nothing at all.
  for (
    const [who, scope, member] of [
      [role, schema, MARKERS],
      ...(markers ?? []).map((marker) => [marker, "", []]),
    ] as const
  ) {
    const found = (await db.query(BEYOND, [scope, who, member])).rows;
    problems.push(...found.map((row) => (who === role ? "" : `(as ${who}) `) + row.problem));
  }
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
    `SELECT (SELECT pg_catalog.array_agg(n.nspname::pg_catalog.text ORDER BY n.nspname) FROM ` +
      `pg_catalog.pg_namespace n WHERE n.nspname <> $1::pg_catalog.name AND n.nspname NOT IN ` +
      `('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND EXISTS (SELECT ` +
      `1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', ` +
      `'v', 'm', 'f'))) AS others, (SELECT pg_catalog.array_agg(extname::pg_catalog.text) FROM ` +
      `pg_catalog.pg_extension WHERE extname IN ('dblink', 'postgres_fdw')) AS remote`,
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
  `(SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON ` +
  `c.oid = t.tgrelid WHERE c.relnamespace = ${`'${ident(schema).replaceAll("'", "''")}'`}::` +
  `pg_catalog.regnamespace AND NOT t.tgisinternal)::pg_catalog.int4`;
