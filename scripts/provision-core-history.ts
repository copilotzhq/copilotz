/** Explicit Core history index installation; preview is read-only. @module */
import { provisionCoreHistoryIndexes } from "../plugins/core/collections/message/storage.ts";
import {
  quoteEventIdentifier,
  type SqlSession,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../runtime/events/index.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/index.ts";

export const HISTORY_PROVISION_USAGE =
  "Usage: DATABASE_URL=URL deno run -A scripts/provision-core-history.ts --schema SCHEMA [--schema SCHEMA ...] [--apply]\nDefault: read-only preview. --apply builds the history index concurrently and analyzes each selected schema.";

export function parseHistoryProvisionArgs(args: readonly string[]): {
  apply: boolean;
  schemas: readonly string[];
  help: boolean;
} {
  const schemas = new Set<string>();
  let apply = false;
  if (args.length === 1 && args[0] === "--help") {
    return { apply, schemas: [], help: true };
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply" && !apply) apply = true;
    else if (args[i] === "--schema") {
      schemas.add(validateEventSchemaName(args[++i] ?? ""));
    } else throw new TypeError(`Unsupported or repeated option: ${args[i]}`);
  }
  if (!schemas.size) throw new TypeError("At least one --schema is required.");
  return { apply, schemas: [...schemas].sort(), help: false };
}

export async function runHistoryProvision(
  session: SqlSession,
  options: Pick<
    ReturnType<typeof parseHistoryProvisionArgs>,
    "schemas" | "apply"
  >,
): Promise<
  {
    mode: "preview" | "apply";
    schemas: readonly {
      schema: string;
      indexPresent: boolean;
      indexValid: boolean;
    }[];
  }
> {
  const schemas = [...new Set(options.schemas.map(validateEventSchemaName))]
    .sort();
  if (!schemas.length) throw new TypeError("At least one schema is required.");
  const inspect = () =>
    session.transaction(async (snapshot) => {
      await snapshot.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const results = [];
      for (const schema of schemas) {
        await validateCopilotzSchema(snapshot, schema);
        const index = await snapshot.query<{ valid: boolean }>(
          `SELECT indisvalid AS valid FROM pg_catalog.pg_index
          WHERE indexrelid = to_regclass($1)`,
          [`${quoteEventIdentifier(schema)}."core_message_thread_created_idx"`],
        );
        results.push({
          schema,
          indexPresent: index.rows.length > 0,
          indexValid: index.rows[0]?.valid ?? false,
        });
      }
      return results;
    });
  // Validate all requested Event schemas before the first mutation.
  const before = await inspect();
  if (options.apply) {
    for (const schema of schemas) {
      await provisionCoreHistoryIndexes(session, schema, {
        concurrently: true,
      });
    }
  }
  return {
    mode: options.apply ? "apply" : "preview",
    schemas: options.apply ? await inspect() : before,
  };
}

if (import.meta.main) {
  try {
    const options = parseHistoryProvisionArgs(Deno.args);
    if (options.help) console.log(HISTORY_PROVISION_USAGE);
    else {
      const url = Deno.env.get("DATABASE_URL")?.trim();
      if (!url) throw new Error("DATABASE_URL is required.");
      const database = await openManagedOminipgDatabase({
        url,
        pgPoolMax: 1,
        requestTimeoutMs: 30 * 60_000,
      });
      try {
        console.log(
          JSON.stringify(
            await runHistoryProvision(database.session, options),
            null,
            2,
          ),
        );
      } finally {
        await database.close();
      }
    }
  } catch {
    // Driver errors may contain connection details. Never print the error or URL.
    console.error(
      "Core history provisioning failed. Check schema/index readiness and the supplied options.",
    );
    Deno.exitCode = 1;
  }
}
