/** Explicit additive deadline-index rollout for already provisioned schemas. */
import {
  contentCatalogStatements,
  readyContentBodyIndexStatement,
} from "../runtime/content/catalog-schema.ts";
import {
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../runtime/events/schema.ts";
import type { SqlSession } from "../runtime/events/session.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/index.ts";

export async function provisionContentIndexes(
  database: SqlSession,
  schema: string,
  apply = false,
) {
  schema = validateEventSchemaName(schema);
  await validateCopilotzSchema(database, schema);
  const statements = [
    ...contentCatalogStatements(schema).filter((sql) =>
      sql.startsWith("CREATE INDEX")
    ),
    readyContentBodyIndexStatement(schema),
  ];
  if (apply) {
    // Schema provisioning intentionally leaves current retained schemas alone.
    // Build only additive indexes here; never rewrite retained content records.
    for (const sql of statements) await database.query(sql);
    for (
      const table of [
        "content_logical_bodies",
        "content_copies",
        "pending_content",
        "content_adoptions",
        "nodes",
      ]
    ) {
      await database.query(`ANALYZE "${schema}"."${table}"`);
    }
  }
  const indexes = await database.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=ANY($2::text[]) ORDER BY indexname",
    [schema, [
      "content_logical_bodies",
      "content_copies",
      "pending_content",
      "content_adoptions",
      "nodes",
    ]],
  );
  return { schema, applied: apply, statements, indexes: indexes.rows };
}

if (import.meta.main) {
  const [schema, option, ...extra] = Deno.args;
  if (!schema || extra.length || option !== undefined && option !== "--apply") {
    throw new TypeError(
      "Usage: DATABASE_URL=URL deno run -A scripts/provision-content-indexes.ts SCHEMA [--apply]",
    );
  }
  const url = Deno.env.get("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is required");
  const database = await openManagedOminipgDatabase({
    url,
    statementTimeoutMs: null,
    requestTimeoutMs: 24 * 60 * 60 * 1000,
  });
  try {
    console.log(
      JSON.stringify(
        await provisionContentIndexes(
          database.session,
          schema,
          option === "--apply",
        ),
        null,
        2,
      ),
    );
  } finally {
    await database.close();
  }
}
