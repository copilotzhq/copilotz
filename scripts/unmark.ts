/**
 * Rehearses chat's migration of the old marks (`chat.unmark`) against a
 * database, reading only: what it would do, by kind (`personal`,
 * `contactChats`, `held`, `unresolved`, and the placeholders it would leave),
 * with every id it would touch, as JSON on standard output.
 *
 * It reads the store as it is, with no owner: it claims nothing, so the app
 * running on that database goes on as it was, and it writes nothing (a
 * read-only database role is enough, once the store's tables are made).
 * The migration itself runs in the app, by itself, on the first start of a
 * release that has it; operators run it again over maintenance
 * (`POST /maintenance/actions/chat.unmark`, `{ "dryRun": true }` to look).
 *
 * The store, from the environment: `DATABASE_URL` (PostgreSQL), with
 * `DATABASE_SCHEMA` and `DATABASE_TENANT` where the app sets them (an org of
 * many), or `SQLITE_PATH`.
 *
 * ```sh
 * DATABASE_URL=postgres://reader@127.0.0.1:5433/app deno task unmark --dry-run
 * ```
 */
import { parseArgs } from "node:util";
import process from "node:process";
import type { Store } from "../runtime/mod.ts";
import { postgresStore } from "../stores/sql/postgres/mod.ts";
import { sqliteStore } from "../stores/sql/sqlite/mod.ts";
import { storeReads, unmark } from "../plugins/agents/chat/shared/unmark.ts";

const USAGE = `Usage: deno task unmark --dry-run

Says what chat's migration of the old marks would do to a database, reading
only. The store comes from DATABASE_URL (with DATABASE_SCHEMA and
DATABASE_TENANT where the app sets them), or SQLITE_PATH.`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    batch: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values["dry-run"]) {
  console.error(
    `${USAGE}\n\nIt only rehearses: the migration runs in the app, by itself, on deploy; to run ` +
      "it again, POST /maintenance/actions/chat.unmark.",
  );
  process.exit(2);
}

/** The app's store, as its environment says. */
async function storeOf(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) {
    return await postgresStore({
      url,
      ...(process.env.DATABASE_SCHEMA ? { schema: process.env.DATABASE_SCHEMA } : {}),
      ...(process.env.DATABASE_TENANT ? { tenant: process.env.DATABASE_TENANT } : {}),
    });
  }
  const path = process.env.SQLITE_PATH;
  if (path) return await sqliteStore({ path });
  console.error(`${USAGE}\n\nNeither DATABASE_URL nor SQLITE_PATH is set.`);
  process.exit(2);
}

const store = await storeOf();
try {
  const batch = values.batch ? Number(values.batch) : undefined;
  const done = await unmark(storeReads(store), {
    dryRun: true,
    ...(batch ? { batch } : {}),
    // The counts, on standard error; what it would touch, on standard output.
    log: (line) => console.error(JSON.stringify(line)),
  });
  console.log(JSON.stringify(done, null, 2));
} finally {
  await (store as { close?: () => Promise<void> }).close?.();
}
