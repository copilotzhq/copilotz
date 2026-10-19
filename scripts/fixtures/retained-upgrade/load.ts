import type { SqlSession } from "../../../runtime/events/session.ts";
import { quoteEventIdentifier } from "../../../runtime/events/schema.ts";

export type RetainedFixture = Readonly<{
  revision: string;
  schema: string;
  statements: readonly string[];
  rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}>;

/** Restore real old-code DDL and records, without synthesizing an older schema. */
export async function restoreRetainedFixture(
  session: SqlSession,
  schema: string,
): Promise<RetainedFixture> {
  const fixture = JSON.parse(
    await Deno.readTextFile(new URL("./baseline.json", import.meta.url)),
  ) as RetainedFixture;
  if (fixture.revision !== "8736b9c8b86f09b8febf3e2510f904ebfd2be28c") {
    throw new Error("Unexpected retained fixture provenance.");
  }
  const destination = quoteEventIdentifier(schema);
  await session.transaction(async (tx) => {
    for (const statement of fixture.statements) {
      await tx.query(
        statement.replaceAll(quoteEventIdentifier(fixture.schema), destination),
      );
    }
    for (const [table, rows] of Object.entries(fixture.rows)) {
      if (!rows.length) continue;
      const target = `${destination}.${quoteEventIdentifier(table)}`;
      await tx.query(
        `INSERT INTO ${target} SELECT * FROM jsonb_populate_recordset(NULL::${target}, $1::jsonb)`,
        [JSON.stringify(rows)],
      );
    }
    for (
      const [table, column] of [["events", "position"], [
        "copilotz_operation_streams",
        "replay_key",
      ]]
    ) {
      const target = `${destination}.${quoteEventIdentifier(table)}`;
      await tx.query(
        `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT max(${
          quoteEventIdentifier(column)
        }) FROM ${target}),1), EXISTS(SELECT 1 FROM ${target}))`,
        [target, column],
      );
    }
  });
  return fixture;
}
