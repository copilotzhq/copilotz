/**
 * A maintenance role of its own on a PostgreSQL server, made as the
 * README's Maintenance sets one up: a login with exactly maintenance's
 * grants on one schema, and on its log only to append. The test database's role makes it,
 * so it needs CREATEROLE; without, `maintainer` answers undefined and the
 * tests that need one are skipped. And a store's own role (`storeLogin`),
 * for maintenance SQL as it (`storeRole`).
 */
import { postgresPool } from "../sql/postgres/mod.ts";

export type Maintainer = {
  /** Where the store's maintenance SQL connects, as this role. */
  url: string;
  role: string;
  /** Grants it what maintenance needs on `schema` (made first, by the store). */
  grant(schema: string): Promise<void>;
  /** Runs SQL as the test database's role (another grant, a role setting). */
  run(sql: string): Promise<unknown[]>;
  /** Drops the role (its schemas first: the privileges go with them). */
  drop(): Promise<void>;
};

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function maintainer(url: string): Promise<Maintainer | undefined> {
  const pool = await postgresPool({ url, writes: 1, reads: 1 });
  const [can] = (await pool.writes.query(
    "SELECT rolcreaterole OR rolsuper AS can FROM pg_roles WHERE rolname = current_user",
  )).rows;
  if (!can?.can) {
    await pool.close();
    return undefined;
  }
  const role = `cpz_m_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = crypto.randomUUID();
  await pool.writes.query(`CREATE ROLE ${ident(role)} LOGIN NOINHERIT PASSWORD '${password}'`);
  const login = new URL(url);
  login.username = role;
  login.password = password;
  const run = async (sql: string) => (await pool.writes.query(sql)).rows;
  return {
    url: login.toString(),
    role,
    run,
    async grant(schema) {
      const s = ident(schema);
      const r = ident(role);
      for (
        const sql of [
          `GRANT USAGE ON SCHEMA ${s} TO ${r}`,
          `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${r}`,
          `GRANT INSERT, UPDATE, DELETE ON ${s}.nodes, ${s}.edges, ${s}.vectors, ${s}.blobs TO ${r}`,
          `GRANT INSERT ON ${s}.events TO ${r}`,
          `GRANT UPDATE (value) ON ${s}.meta TO ${r}`,
        ]
      ) await run(sql);
    },
    async drop() {
      // What it was granted goes with it (where this role may say so), then the role.
      await run(`DROP OWNED BY ${ident(role)}`).catch(() => {});
      await run(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
      await pool.close();
    },
  };
}

/** A store's own role, made for a test: where it connects, and how to drop it. */
export type Login = Omit<Maintainer, "grant">;

/**
 * A role for a store of its own, as an app's own role is: a login that may
 * make schemas in the test database (and so owns the store's), with
 * `attributes` beyond LOGIN (`CREATEROLE`). Made as the test database's
 * role, which needs CREATEROLE, as for `maintainer`; else undefined. Drop
 * the store first: the role goes only once its schema has.
 */
export async function storeLogin(url: string, attributes = ""): Promise<Login | undefined> {
  const pool = await postgresPool({ url, writes: 1, reads: 1 });
  const [can] = (await pool.writes.query(
    "SELECT rolcreaterole OR rolsuper AS can, current_database() AS db FROM pg_roles WHERE " +
      "rolname = current_user",
  )).rows;
  if (!can?.can) {
    await pool.close();
    return undefined;
  }
  const role = `cpz_s_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = crypto.randomUUID();
  const run = async (sql: string) => (await pool.writes.query(sql)).rows;
  await run(`CREATE ROLE ${ident(role)} LOGIN ${attributes} PASSWORD '${password}'`);
  await run(`GRANT CREATE ON DATABASE ${ident(String(can.db))} TO ${ident(role)}`);
  const login = new URL(url);
  login.username = role;
  login.password = password;
  return {
    url: login.toString(),
    role,
    run,
    async drop() {
      await run(`REVOKE CREATE ON DATABASE ${ident(String(can.db))} FROM ${ident(role)}`)
        .catch(() => {});
      await run(`DROP OWNED BY ${ident(role)}`).catch(() => {});
      await run(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
      await pool.close();
    },
  };
}
