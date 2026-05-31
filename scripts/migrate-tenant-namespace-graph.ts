/**
 * One-way pre-1.0 migration for the namespace semantics refactor.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-net \
 *     scripts/migrate-tenant-namespace-graph.ts --namespace compass
 *
 * The provided namespace is the tenant/application partition. Legacy RAG
 * document namespaces are converted into knowledge_space nodes inside that
 * tenant namespace.
 *
 * @module
 */
import { Ominipg } from "omnipg";
import { resolveAutoProviders } from "omnipg/auto";
import { createPGliteProvider } from "omnipg/pglite";
import { migrateTenantNamespaceGraphWithQuery } from "@/server/migrations.ts";

function readArg(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index >= 0) return Deno.args[index + 1];
  const prefixed = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

const namespace = readArg("--namespace") ?? Deno.env.get("COPILOTZ_NAMESPACE");
if (!namespace) {
  console.error("Missing --namespace <tenant-namespace>.");
  Deno.exit(1);
}

const url = Deno.env.get("DATABASE_URL") ?? ":memory:";
const providers = resolveAutoProviders({ url });
const db = await Ominipg.connect({
  url,
  ...providers,
  pgliteProvider: url === ":memory:" || url.startsWith("file:")
    ? createPGliteProvider()
    : undefined,
  // This script is a data/shape migration for an already-created database.
  // Running the full library schema provisioning here can be expensive on
  // local PGlite data dirs and is unnecessary for the one-way pre-1.0 rewrite.
  schemaSQL: [],
  pgliteExtensions: url === ":memory:" || url.startsWith("file:")
    ? ["uuid_ossp", "pg_trgm", "vector"]
    : [],
});

await migrateTenantNamespaceGraphWithQuery(db, namespace);

console.log(
  `Migrated Copilotz graph namespace semantics to tenant namespace "${namespace}".`,
);

Deno.exit(0);
