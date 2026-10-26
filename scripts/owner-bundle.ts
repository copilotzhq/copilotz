/** Offline CLI; the supported programmatic surface is /migration. */
import {
  exportOwnerBundle,
  importOwnerBundle,
  migrateOwnerKeys,
  type OwnerTransferConfig,
} from "@copilotz/copilotz/migration";
import { openManagedOminipgDatabase } from "@copilotz/copilotz/persistence";
import { resolve, toFileUrl } from "@std/path";
if (import.meta.main) {
  const [command, ...args] = Deno.args;
  const get = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const url = Deno.env.get("COPILOTZ_TRANSFER_DATABASE_URL"),
    configPath = get("config"),
    directory = get("bundle"),
    schema = get("schema");
  if (
    !url || !configPath || !args.includes("--offline") ||
    !["export", "import", "migrate"].includes(command)
  ) {
    throw new Error(
      "Set COPILOTZ_TRANSFER_DATABASE_URL; use export|import|migrate --config=MODULE.ts --offline [--schema=SCHEMA] [--bundle=DIRECTORY]. Stop all owners and producers first.",
    );
  }
  const config = (await import(toFileUrl(resolve(configPath)).href))
    .default as OwnerTransferConfig;
  if (command === "export") {
    if (!schema || !directory) {
      throw new Error("Export requires --schema and --bundle.");
    }
    await exportOwnerBundle({ url, schema, directory, config });
  } else if (command === "import") {
    if (!directory) throw new Error("Import requires --bundle.");
    await importOwnerBundle({
      url,
      directory,
      adapter: config.destinationAdapter,
    });
  } else {
    if (!schema) throw new Error("Migration requires --schema.");
    const db = await openManagedOminipgDatabase({
      url,
      statementTimeoutMs: null,
      requestTimeoutMs: 24 * 60 * 60 * 1000,
    });
    try {
      console.log(
        await migrateOwnerKeys({
          session: db.session,
          schema,
          sourceAdapter: config.sourceAdapter,
          masterAdapter: config.destinationAdapter,
          bindings: config.bindings,
          readExternalBody: config.readExternalBody,
        }),
      );
    } finally {
      await db.close();
    }
  }
}
