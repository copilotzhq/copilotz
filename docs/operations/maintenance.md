---
title: "Maintenance"
description: "SQL over HTTP for an app's operators when they can't reach its database: the endpoints, the key, the record, the limits, and the PostgreSQL role it runs as."
section: Operations
order: 2
---

# Maintenance

When an app's operators can't reach its database, the `maintenance` plugin answers for it over HTTP.
A client's network that keeps their database user out is the usual reason.

## Turning it on

The plugin comes from `copilotz/plugins/interfaces`. It answers under `/maintenance/`, with a key
the app gives it:

```ts
import { maintenance } from "copilotz/plugins/interfaces";

const runtime = await createRuntime({
  store,
  plugins: [
    ...plugins,
    maintenance,
    definePlugin({ name: "app", resources: { maintenance: { key: process.env.MAINTENANCE_KEY } } }),
  ],
});
```

It's the one place an app runs SQL of its own. Plugin code never does.

```sh
curl https://app.example.com/maintenance/sql -H "authorization: Bearer $KEY" \
  -d '{"sql": "SELECT _id, text FROM message WHERE thread = $1", "params": ["t1"]}'
```

## The endpoints

| Endpoint                                          | What it does                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /maintenance/`                               | What's here: whether the store runs SQL, the collections, the limits                                   |
| `POST /maintenance/sql`                           | `{ sql, params?, limit?, timeout? }`: one read-only statement: `{ rows, count, truncated, ms }`        |
| `POST /maintenance/sql/write`                     | `{ sql, params?, limit?, timeout? }`: one that writes, in the owner: `{ changed, rows, event }`        |
| `POST /maintenance/collections/<collection>/<op>` | `insertOne` `{ doc }`… `deleteMany` `{ filter }`, and `find`, `findOne`, `countDocuments`, `aggregate` |
| `POST /maintenance/queries/<collection>.<name>`   | A collection's named query (`booking.stats`), the body its params: `{ result, ms }`                    |
| `GET /maintenance/blobs/<sha256-…>`               | A blob's bytes and type, as a download                                                                 |

## Keys

Give one `key`, or several in `keys` while one rotates: add the new one, move clients, then drop the
old one.

Each key is at least 32 random characters. A short one, or one plainly not random, stops the app
from starting.

Every request shows a key, as `Authorization: Bearer <key>`, compared in constant time. Without a
key configured, every request is unauthorized, the same answer as a wrong key.

## Who it acts as

A request acts as the maintenance actor, `{ kind: "maintenance", id: "maintenance", by }`. `by` is
what the `X-Maintenance-By` header says, as said.

Its Actions let only that actor call them, and they run as the system, on the record (`ctx.as()`).
No rule keeps it from a document, and every event says `via` it. Their ops count in
[`copilotz.elevated.ops`](metrics.md), as `system`.

Writes take an `Idempotency-Key`. Sent again, a write answers what it did the first time.

## On the record twice

Before it runs, each request writes a line to `log`, which by default is JSON on standard output,
where Cloud Run keeps it. The line says who, what, which key and when. For a statement, "what" is
its SHA-256 and its params' count. Otherwise it's the operation, the query or the blob.

A SQL write also records a `maintenance.sql` event in the same commit.

The log line is the record the key's holder can't rewrite.

## Limits

- `limit` rows: 1,000.
- `timeout`: 30 s.
- `bytes` of rows in an answer: 8 MB. Past it the rows are cut, and `truncated` says so.

A request may ask for less. A pipeline stops at the limit too.

## Prefer the operations

The collections' operations go through the owner's write path. They're checked against the
collection's schema, recorded as its events, cached and heard by Processors like any write. Prefer
them to SQL.

Named queries run as the system does them, `runtime.query` with no actor, and check their own
params.

## Read SQL

Read SQL is one statement. A `;` outside its strings and comments ends it. PostgreSQL's line
comments end at a CR too, and maintenance reads strings with `standard_conforming_strings` on.

It runs in a read-only transaction that's always rolled back, stopped at its limit and cut off at
its timeout.

## Raw SQL writes

Raw SQL writes run inside the owner (`runtime.maintenance.write`, see `runtime/maintain.ts`), for
what operations can't do.

Each runs alone among the owner's writes: those running end first, and the next ones wait for it. It
runs in a transaction fenced by the owner's epoch, so an owner that lost the store can't run one.
Its `maintenance.sql` event goes in the same commit: the statement, its params, the rows it changed
in any table, and who.

A raw write bypasses schemas and per-document events. So the owner then forgets what it derived from
documents: its cache empties, it lets go of every reach it kept, observed Views run again, and the
clock reads the timers again.

Some statements don't run at all:

- one that ends or nests its transaction (`COMMIT`, `SAVEPOINT`…);
- one that changes its connection (`SET`, `PREPARE`, `LISTEN`, SQLite's `ATTACH`, `PRAGMA`…);
- in PostgreSQL, one that reaches past the statement: `ALTER ROLE` (a role may set its own password
  and settings, which outlive the key), `DO` (a block runs statements nothing reads first) and
  `LOCK` (it would hold the store's tables against the app's own writes).

A write still holds the row locks it takes, such as the rows an `UPDATE` changes, until it commits.
App writes to those rows wait, at most its `timeout`, with at most 2 maintenance statements at once.

Some writes are rolled back: one that changes the store's own state (`meta`: the fencing epoch,
Processors' positions), one that changes what the role holds (a large object, a setting), and, in
SQLite, one that leaves a temporary object.

The record keeps a password literal as `PASSWORD '***'`.

## Nothing outlives its statement

On a PostgreSQL server, each statement runs on a connection of its own, closed after. What it sets
on its session (a setting, a session lock, a prepared statement) goes with it. It goes over the
extended protocol, where the server refuses a second statement whatever the check said.

PGlite has one session. Maintenance has it forget what it left there (`DISCARD ALL`).

A SQLite read runs apart, in a process of its own, on a read-only connection, killed at its timeout.
A statement that never ends doesn't hold the app, a core or the WAL.

That process is `deno`, `node` or `bun` itself, never a compiled app, which would be the app again.
It has an empty environment. On Deno and Node it may read the database's files and nothing else. On
Deno it's started only when permission to run is already granted, so nothing ever asks mid-request.

Where no process can start (a database opened another way, `:memory:`, a compiled app, no
permission), reads run on the store's reading connection. They then run one at a time, with no
timeout, and a pragma only from those that only read. The store says so once, with why, and each
such answer says `inline: true`.

SQLite writes name the store's tables in `main`, so nothing temporary stands in for them.

Each store runs at most 2 maintenance statements at once (`maintenance: { connections }`). Another
answers busy, with a 503.

## Where it runs

SQL needs a SQL store.

On a PostgreSQL server it runs only as a role of its own, or, told so, as the store's own role. It
never runs in a schema other tenants share.

PGlite, in the app's process, runs it as its one session, where it reaches no other schema.

An org's runtime behind a directory, one with `directory.member`, doesn't serve maintenance at all:
one key would reach every org.

Operations, named queries and blobs work everywhere, the memory store too, and need no role.

## A role of its own

On a PostgreSQL server, raw SQL runs only as a role of its own, named by the store:

```ts
postgresStore({ url, schema, maintenance: { url: process.env.MAINTENANCE_DATABASE_URL } });
```

Without one it's refused, unless the store is told to run it as its own role, below.

The store's role owns the tables, may stop the app's connections, and is whatever the deployment
made it, even a superuser. Nothing that runs at a key's word should be it.

### What maintenance checks

Before each statement, on the connection that runs it, and again after a write in its transaction,
maintenance checks that the role holds exactly what the SQL below grants. Otherwise it refuses,
rolling a write back, and says what's more:

- an attribute beyond `LOGIN` (superuser, `CREATEROLE`…);
- membership in any role at all, predefined (`pg_*`) or not, whatever its `INHERIT` or `SET`
  options, since a member could `SET ROLE` to it;
- settings of its own (`ALTER ROLE … SET`);
- anything it owns, a large object too (what it makes for its own session, a temporary table, goes
  with its connection);
- anything granted to it outside the store's schema and database;
- `CREATE` on any schema, `public` too, or on the database;
- any privilege on a table or a column of another schema;
- on the store's own tables, anything beyond the grants below: no `TRIGGER`, `TRUNCATE` or
  `REFERENCES`, and on `events` only `INSERT`;
- a large object it may read (`lo_compat_privileges`, or one granted to `PUBLIC`);
- a `SECURITY DEFINER` function it may run, since one runs as its owner;
- `dblink` or `postgres_fdw` in the database;
- a trigger on the store's tables, which the store never makes.

The checks name every catalog they read as `pg_catalog`'s, after setting the search path back to it,
so nothing a statement made stands in for them.

### Signing it in

Prefer a role with no password at all, signed in by the platform: Cloud SQL's IAM database
authentication, or a client certificate. A password is a second key, valid for as long as nobody
changes it.

On Cloud SQL, with a service account of its own for maintenance:

```sh
gcloud sql users create maintenance@PROJECT.iam --instance=INSTANCE --type=cloud_iam_service_account
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:maintenance@PROJECT.iam.gserviceaccount.com \
  --role=roles/cloudsql.instanceUser   # and roles/cloudsql.client, to connect
# The app reaches it through the Cloud SQL Auth Proxy, which signs it in (no password):
#   cloud-sql-proxy --auto-iam-authn --impersonate-service-account=maintenance@PROJECT.iam.gserviceaccount.com \
#     --port 5433 PROJECT:REGION:INSTANCE
# MAINTENANCE_DATABASE_URL=postgres://maintenance%40PROJECT.iam@127.0.0.1:5433/DATABASE
```

Cloud SQL makes such a role a member of its own marker role: `cloudsqliamserviceaccount`, or
`cloudsqliamuser` for a person. That one membership is allowed, without ADMIN OPTION.

Every IAM user is a member of the marker too, so the marker may hold nothing at all. Grant it
nothing, not even the grants below: maintenance refuses a marker that holds anything. Then make the
grants below, naming `"maintenance@PROJECT.iam"`.

### The grants

Elsewhere, run this as the store's role (the schema's owner), once the app has started once and made
the schema. The first line needs a role that may create roles:

```sql
-- LOGIN and nothing else; never grant it a role. (On Cloud SQL with IAM, gcloud makes it.)
CREATE ROLE copilotz_maintenance LOGIN PASSWORD '…' NOINHERIT;
GRANT USAGE ON SCHEMA copilotz TO copilotz_maintenance;
-- Reading everything there, the collections' views too, now and later.
GRANT SELECT ON ALL TABLES IN SCHEMA copilotz TO copilotz_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA copilotz GRANT SELECT ON TABLES TO copilotz_maintenance;
-- Changing documents, edges, vectors and blobs.
GRANT INSERT, UPDATE, DELETE ON copilotz.nodes, copilotz.edges, copilotz.vectors, copilotz.blobs
  TO copilotz_maintenance;
-- Appending to the log (its own audit events), never changing it.
GRANT INSERT ON copilotz.events TO copilotz_maintenance;
-- Holding the fence while it writes (FOR SHARE needs it); a statement that changes meta is rolled back.
GRANT UPDATE (value) ON copilotz.meta TO copilotz_maintenance;
-- PostgreSQL 14 and earlier let everyone create in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Replace `copilotz` with the store's schema.

`PUBLIC` keeps `CONNECT` on the database, `TEMPORARY`, and `USAGE` on `public`. Those are allowed.

Everyone (`PUBLIC`) can run a `SECURITY DEFINER` function unless it's revoked. Find them, and revoke
it from each, or maintenance refuses, naming them:

```sql
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.prosecdef
  AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace);
REVOKE EXECUTE ON FUNCTION some_schema.some_function(…) FROM PUBLIC;
```

## Or the store's own role

Where a role of its own is more than a deployment wants, raw SQL can run as the store's own role
instead. You say so in so many words:

```ts
postgresStore({ url, schema, maintenance: { storeRole: true } });
```

`connections` works as above. Each statement then connects as the role in the store's `url`, or its
pool's. Naming `url` and `storeRole` together stops the store from opening.

### What it costs

Anyone holding the maintenance key can then do whatever the store's role can.

The role owns the store's tables. A statement can drop or truncate them, delete from the log, or
rewrite any document without an event.

It can read every schema the role reaches, another app's on the same database too if the role may.
It can stop the app's own connections, and create roles or databases if the role may.

A leaked key is then almost the app's own database login.

### What still holds

Only the role check above is skipped, which the store's role couldn't pass. Everything else holds:

- the statement filter (no `COMMIT`, `SET`, `ALTER ROLE`, `DO`, `LOCK`…);
- the extended protocol, and a connection of its own for each statement, closed after;
- timeouts, the row and byte caps, and at most `connections` at once;
- writes inside the owner, fenced, with their `maintenance.sql` event;
- a statement that changes `meta` or makes a trigger, rolled back;
- the owner's cache and kept reach, emptied after a write;
- the key, and the log line.

### What's still refused

Before each statement, and again after a write in its transaction, maintenance refuses a role that
could turn SQL into commands on the database server, or into access to its files. It says why:

- a superuser;
- a member, by any path, of a superuser role, since it could switch to it within a statement;
- a member of `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`;
- before PostgreSQL 16, a role with `CREATEROLE`, which is enough to grant itself any of those;
- a role that may run `pg_read_file`, `pg_read_binary_file`, `lo_import`, `lo_export` or adminpack's
  file functions.

Cloud SQL's `postgres` user isn't a superuser. It's a member of `cloudsqlsuperuser`, which isn't one
either. From PostgreSQL 16 it passes. On 15 or earlier its `CREATEROLE` is refused, so use a role of
its own there.
