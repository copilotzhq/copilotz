/** Bounded native-database reads for the stopped-producer migration only. */
import type { SqlExecutor } from "../events/session.ts";
import { bodyStoreTables } from "./body-store-schema.ts";
import type { TerminalBodyHead } from "./body-store.ts";
import { digestContent } from "./digest.ts";

export type OfflinePrefix = {
  head: TerminalBodyHead;
  length: number;
  digest: string;
};
export async function inspectOfflinePrefixes(
  session: SqlExecutor,
  schema: string,
  requests: ReadonlyMap<string, { key: string; length?: number }>,
): Promise<ReadonlyMap<string, OfflinePrefix>> {
  const tables = bodyStoreTables(schema);
  const output = new Map<string, OfflinePrefix>();
  const entries = [...requests];
  for (let start = 0; start < entries.length; start += 2000) {
    const slice = entries.slice(start, start + 2000);
    const heads = (await session.query<{
      body_id: string;
      state: string;
      media_type: string;
      byte_length: string;
      digest: `sha256:${string}`;
      version_token: string;
      maintenance_version: string;
      updated_at: string | Date;
    }>(
      `SELECT body_id,state,media_type,byte_length,digest,version_token,maintenance_version,updated_at FROM ${tables.bodies} WHERE body_id=ANY($1::text[])`,
      [slice.map(([, request]) => request.key)],
    )).rows;
    const byKey = new Map(heads.map((head) => [head.body_id, head]));
    const ready = slice.flatMap(([id, request]) => {
      const head = byKey.get(request.key);
      if (!head || !["ready", "incomplete"].includes(head.state)) return [];
      const length = request.length ?? Number(head.byte_length);
      // Large individual bodies retain the existing chunked reader. Invalid
      // claims likewise go through its exact validation/error path.
      if (
        !Number.isSafeInteger(length) || length < 0 ||
        length > 16 * 1024 * 1024 || length > Number(head.byte_length)
      ) return [];
      return [{ id, key: request.key, length, head }];
    });
    let offset = 0;
    while (offset < ready.length) {
      let end = offset, size = 0;
      while (
        end < ready.length &&
        (end === offset || size + ready[end].length <= 16 * 1024 * 1024)
      ) size += ready[end++].length;
      const batch = ready.slice(offset, end);
      const rows = (await session.query<
        { id: string; start_offset: string | null; bytes: Uint8Array | null }
      >(
        `SELECT v.id,p.start_offset,substring(p.bytes FROM 1 FOR (v.length-p.start_offset)::integer) AS bytes
         FROM jsonb_to_recordset($1::jsonb) AS v(id text,key text,length bigint)
         LEFT JOIN ${tables.parts} p ON p.body_id=v.key AND p.start_offset<v.length
         ORDER BY v.id,p.start_offset`,
        [JSON.stringify(
          batch.map(({ id, key, length }) => ({ id, key, length })),
        )],
      )).rows;
      const parts = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = parts.get(row.id) ?? [];
        list.push(row);
        parts.set(row.id, list);
      }
      for (const item of batch) {
        const bytes = new Uint8Array(item.length);
        let covered = 0;
        for (const part of parts.get(item.id) ?? []) {
          if (part.bytes === null || part.start_offset === null) continue;
          if (
            Number(part.start_offset) !== covered ||
            covered + part.bytes.length > bytes.length
          ) {
            throw new Error(
              "Database body range has missing or overlapping parts.",
            );
          }
          bytes.set(part.bytes, covered);
          covered += part.bytes.length;
        }
        if (covered !== item.length) {
          throw new Error("Catalog prefix is unavailable.");
        }
        output.set(item.id, {
          head: {
            bodyId: item.key,
            state: item.head.state as "ready" | "incomplete",
            mediaType: item.head.media_type,
            byteLength: Number(item.head.byte_length),
            digest: item.head.digest,
            versionToken: item.head.version_token,
            etag: item.head.version_token,
            lastModified: new Date(item.head.updated_at).toISOString(),
            maintenanceVersion: Number(item.head.maintenance_version),
          },
          length: item.length,
          digest: await digestContent(bytes),
        });
      }
      offset = end;
    }
    console.error(
      `[upgrade:${schema}] content prefixes ${
        Math.min(start + 2000, entries.length)
      }/${entries.length}`,
    );
  }
  return output;
}
