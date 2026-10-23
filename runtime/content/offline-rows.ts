/** Payloads live only in the current keyset batch. Keys preserve JS locale ordering. */
import { sha256 } from "@noble/hashes/sha256";
import type { SqlExecutor } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
export type RetainedRow = {
  namespace: string;
  id: string;
  value: unknown;
  kind: "node" | "event";
};
export type RowManifest = { count: number; digest: string };
export function jsonHash() {
  const hash = sha256.create();
  return {
    update(text: string) {
      hash.update(new TextEncoder().encode(text));
    },
    digest() {
      return `sha256:${
        Array.from(hash.digest(), (v) => v.toString(16).padStart(2, "0")).join(
          "",
        )
      }`;
    },
  };
}
export async function* retainedRows(
  session: SqlExecutor,
  schema: string,
): AsyncGenerator<RetainedRow> {
  const tables = createCoreTableNames(schema);
  for (const kind of ["event", "node"] as const) {
    const table = kind === "event" ? tables.event_bodies : tables.nodes;
    const id = kind === "event" ? "event_body_id" : "id";
    const value = kind === "event" ? "body" : "data";
    // SQL collation is not JS localeCompare. Sort identities only, never values.
    const keys: { namespace: string; id: string }[] = [];
    let after: [string, string] | undefined;
    while (true) {
      const batch = (await session.query<{ namespace: string; id: string }>(
        `SELECT namespace,${id} AS id FROM ${table}
         ${
          after
            ? `WHERE (namespace COLLATE "C",${id} COLLATE "C")>($1 COLLATE "C",$2 COLLATE "C")`
            : ""
        }
         ORDER BY namespace COLLATE "C",${id} COLLATE "C" LIMIT 2000`,
        after ?? [],
      )).rows;
      keys.push(...batch);
      if (batch.length < 2000) break;
      after = [batch.at(-1)!.namespace, batch.at(-1)!.id];
    }
    keys.sort((a, b) =>
      a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id)
    );
    for (let start = 0; start < keys.length; start += 1000) {
      const rows =
        (await session.query<{ namespace: string; id: string; value: unknown }>(
          `SELECT t.namespace,t.${id} AS id,t.${value} AS value FROM
         jsonb_to_recordset($1::jsonb) AS k(namespace text,id text,ordinal integer)
         JOIN ${table} t ON t.namespace=k.namespace AND t.${id}=k.id ORDER BY k.ordinal`,
          [JSON.stringify(
            keys.slice(start, start + 1000).map((key, ordinal) => ({
              ...key,
              ordinal,
            })),
          )],
        )).rows;
      for (const row of rows) {
        yield { namespace: row.namespace, id: row.id, value: row.value, kind };
      }
    }
  }
}
export async function contentFingerprint(
  session: SqlExecutor,
  plan: {
    schema: string;
    inventory: unknown;
    rows: readonly RetainedRow[] | RowManifest;
    streamRows: unknown;
  },
): Promise<{ fingerprint: string; rows: RowManifest }> {
  const hash = jsonHash(), rowHash = jsonHash();
  hash.update(
    `{"schema":${JSON.stringify(plan.schema)},"inventory":${
      JSON.stringify(plan.inventory)
    },"rows":[`,
  );
  rowHash.update("[");
  let count = 0;
  for await (
    const row of Array.isArray(plan.rows)
      ? plan.rows
      : retainedRows(session, plan.schema)
  ) {
    const text = (count++ ? "," : "") + JSON.stringify(row);
    hash.update(text);
    rowHash.update(text);
  }
  rowHash.update("]");
  hash.update(`],"streamRows":${JSON.stringify(plan.streamRows)}}`);
  return {
    fingerprint: hash.digest(),
    rows: { count, digest: rowHash.digest() },
  };
}
