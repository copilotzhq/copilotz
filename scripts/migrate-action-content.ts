/** Offline removal of execution-owned content. Drain before applying. */
import { migrateActionContent } from "../runtime/actions/content-migration.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
export { migrateActionContent };
export type {
  ContentMigrationDecision,
  ContentMigrationReport,
} from "../runtime/actions/content-migration.ts";

if (import.meta.main) {
  const args = Deno.args;
  const schema = args.find((arg) => arg.startsWith("--schema="))?.slice(9);
  const decisionsPath = args.find((arg) => arg.startsWith("--decisions="))
    ?.slice(12);
  if (
    !schema ||
    args.some((arg) =>
      !arg.startsWith("--schema=") && !arg.startsWith("--decisions=") &&
      arg !== "--apply"
    )
  ) {
    throw new Error(
      "Usage: COPILOTZ_MIGRATION_DATABASE_URL=... deno run -A scripts/migrate-action-content.ts --schema=SCHEMA [--apply --decisions=FILE.json]",
    );
  }
  const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
  if (!url) throw new Error("COPILOTZ_MIGRATION_DATABASE_URL is required.");
  const decisions = decisionsPath
    ? JSON.parse(await Deno.readTextFile(decisionsPath))
    : undefined;
  const database = await openManagedOminipgDatabase({ url });
  try {
    console.log(
      JSON.stringify(
        await migrateActionContent(database.session, schema, {
          apply: args.includes("--apply"),
          decisions,
        }),
        null,
        2,
      ),
    );
  } finally {
    await database.close();
  }
}
