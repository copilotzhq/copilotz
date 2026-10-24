/** Offline storage utilities. Owners and all physical producers must be stopped. */
import {
  isLegacyObjectBodyStore,
  legacyObjectBodyReader,
} from "../content/legacy-object-body-store.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import {
  bodyStoreTables,
  provisionBodyStoreSchema,
} from "../content/body-store-schema.ts";
import { base64ToBytes, bytesToBase64 } from "../content/encoding.ts";
import { digestContent } from "../content/digest.ts";
import { BODY_APPEND_MAX_BYTES } from "../content/body-store-operations.ts";
import type {
  BodyReader,
  BodyStore,
  S3BodyStorageConfig,
} from "../content/body-store.ts";
import { createS3Requester } from "../content/s3-request.ts";
import {
  BODY_MANIFEST_DECODE_BYTES,
  decodeBodyObjectManifest,
} from "../content/body-object-manifest.ts";
import {
  objectBodyRoot,
  objectIdentityHash,
} from "../content/object-owner-prefix.ts";

export type TransferBody = {
  bodyId: string;
  key: string;
  namespace: string;
  backendKind: string;
  backendId: string;
  mediaType: string;
  bytes: string;
  digest: `sha256:${string}`;
  outcome: "completed" | "failed" | "cancelled";
};
export type { BodyReader } from "../content/body-store.ts";
export function bodyStoreReader(
  storeFor: (backendId: string, namespace: string) => BodyStore,
): BodyReader {
  return async (copy) => {
    const store = storeFor(copy.backendId, copy.namespace);
    if (isLegacyObjectBodyStore(store)) {
      return await legacyObjectBodyReader(store)(copy);
    }
    const head = await store.head({ bodyId: copy.key });
    if (!head || head.byteLength < copy.length) {
      throw new Error("Missing retained body.");
    }
    const bytes = new Uint8Array(copy.length);
    for (
      let offset = 0;
      offset < bytes.length;
      offset += BODY_APPEND_MAX_BYTES
    ) {
      bytes.set(
        await store.readRange({
          bodyId: copy.key,
          offset,
          end: Math.min(bytes.length, offset + BODY_APPEND_MAX_BYTES),
        }),
        offset,
      );
    }
    return { bytes, mediaType: head.mediaType };
  };
}
/** Explicit old S3 layout reader, used only by the offline migration. */
export function oldS3BodyReader(
  config: S3BodyStorageConfig,
  options: { fetch?: typeof fetch } = {},
): BodyReader {
  const send = createS3Requester(config, options);
  return async (copy) => {
    if (copy.backendId !== config.backendId) {
      throw new Error("Wrong migration backend.");
    }
    const base = `${await objectBodyRoot(
      config.prefix ?? "",
    )}${await objectIdentityHash(copy.key)}`;
    const response = await send({
      method: "GET",
      objectName: `${base}/manifest.json`,
      maxResponseBytes: BODY_MANIFEST_DECODE_BYTES,
    });
    if (response.status !== 200) throw new Error("Missing old S3 manifest.");
    const body = decodeBodyObjectManifest(response.bytes);
    if (
      body.bodyId !== copy.key || body.byteLength < copy.length ||
      !["ready", "incomplete"].includes(body.state)
    ) throw new Error("Invalid old S3 body.");
    const bytes = new Uint8Array(copy.length);
    let offset = 0;
    for (const part of body.parts) {
      const response = await send({
        method: "GET",
        objectName: `${base}/parts/${await objectIdentityHash([
          body.reservationId,
          body.fencedFrom ?? body.generation,
          part,
        ])}`,
        maxResponseBytes: BODY_APPEND_MAX_BYTES,
      });
      if (
        response.status !== 200 || part.offset !== offset ||
        response.bytes.length !== part.length ||
        await digestContent(response.bytes) !== part.digest
      ) throw new Error("Corrupt old S3 body.");
      const chunk = response.bytes.subarray(
        0,
        Math.max(0, bytes.length - offset),
      );
      bytes.set(chunk, Math.min(offset, bytes.length));
      offset += part.length;
    }
    if (offset < bytes.length) throw new Error("Truncated old S3 body.");
    return { bytes, mediaType: body.mediaType };
  };
}
export async function lockOwnerTables(
  executor: SqlExecutor,
  schema: string,
  mode: "SHARE" | "ACCESS EXCLUSIVE",
) {
  const tables = (await executor.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
    [schema],
  )).rows;
  if (!tables.length) throw new Error("Owner schema is absent.");
  await executor.query(
    `LOCK TABLE ${
      tables.map(({ table_name }) =>
        `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table_name)}`
      ).join(",")
    } IN ${mode} MODE`,
  );
}
export async function readTransferBodies(
  executor: SqlExecutor,
  schema: string,
  external?: BodyReader,
): Promise<TransferBody[]> {
  const result: TransferBody[] = [];
  for await (const body of iterateTransferBodies(executor, schema, external)) {
    result.push(body);
  }
  return result;
}

/** Verify every copy, yielding bounded batches so upgrades need not retain plain bytes. */
export async function* iterateTransferBodies(
  executor: SqlExecutor,
  schema: string,
  external?: BodyReader,
): AsyncGenerator<TransferBody> {
  const tables = createCoreTableNames(schema),
    physical = bodyStoreTables(schema);
  // A purged historical failed stream retains only its zero-length tombstone.
  // Every other logical body must still resolve to its exact physical copy.
  const invalid =
    (await executor.query(`SELECT 1 FROM ${tables.content_logical_bodies} b
    LEFT JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy
    WHERE (c.copy_key IS NULL AND NOT COALESCE((b.revocation='revoked' AND b.committed_offset=0 AND b.terminal->>'outcome'='failed' AND b.terminal->>'length'='0'),FALSE)) OR c.body_id<>b.body_id OR c.state NOT IN ('current','retired') OR b.revocation='revoking' LIMIT 1`))
      .rows;
  const retiring = (await executor.query(
    `SELECT 1 FROM ${tables.owner_body_retirements} WHERE completed=FALSE LIMIT 1`,
  )).rows;
  if (invalid.length || retiring.length) {
    throw new Error(
      "Resolve inconsistent copies and pending retirements before transfer.",
    );
  }
  const pending = (await executor.query(
    `SELECT 1 FROM ${tables.content_logical_bodies} WHERE terminal IS NULL OR promotion_target IS NOT NULL LIMIT 1`,
  )).rows;
  if (pending.length) {
    throw new Error("Drain logical writers and promotions before transfer.");
  }
  let after = "", total = 0;
  while (true) {
    const rows = (await executor.query<{
      body_id: string;
      namespace: string;
      current_copy: string;
      backend_kind: string;
      backend_id: string;
      physical_state: string | null;
      media_type: string | null;
      byte_length: string | null;
      terminal: {
        outcome: TransferBody["outcome"];
        length: number;
        digest?: `sha256:${string}`;
      };
    }>(
      `SELECT b.body_id,b.namespace,b.current_copy,b.terminal,c.backend_kind,c.backend_id,p.state AS physical_state,p.media_type,p.byte_length FROM ${tables.content_logical_bodies} b JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy LEFT JOIN ${physical.bodies} p ON c.backend_kind='database' AND p.body_id=b.current_copy WHERE c.state='current' AND b.body_id COLLATE "C">$1 COLLATE "C" ORDER BY b.body_id COLLATE "C" LIMIT 2000`,
      [after],
    )).rows;
    if (!rows.length) break;
    after = rows.at(-1)!.body_id;
    let done = 0;
    while (done < rows.length) {
      let end = done, size = 0;
      while (end < rows.length && end - done < 2000) {
        const length = Number(rows[end].byte_length ?? 0);
        if (end > done && size + length > 16 * 1024 * 1024) break;
        size += length;
        end++;
      }
      const batch = rows.slice(done, end);
      const keys = batch.filter((row) => row.backend_kind === "database").map((
        row,
      ) => row.current_copy);
      const partsByBody = new Map<
        string,
        { start_offset: string; bytes: string; part_digest: string }[]
      >();
      if (keys.length) {
        const parts = (await executor.query<
          {
            body_id: string;
            start_offset: string;
            bytes: string;
            part_digest: string;
          }
        >(
          `SELECT body_id,start_offset,encode(bytes,'base64') AS bytes,part_digest FROM ${physical.parts} WHERE body_id=ANY($1::text[]) ORDER BY body_id,start_offset`,
          [keys],
        )).rows;
        for (const part of parts) {
          const list = partsByBody.get(part.body_id) ?? [];
          list.push(part);
          partsByBody.set(part.body_id, list);
        }
      }
      for (const row of batch) {
        let bytes: Uint8Array, mediaType: string;
        if (row.backend_kind === "database") {
          if (
            !row.physical_state ||
            !["ready", "incomplete"].includes(row.physical_state) ||
            Number(row.byte_length) < row.terminal.length
          ) {
            throw new Error("Missing database body.");
          }
          mediaType = row.media_type!;
          bytes = new Uint8Array(row.terminal.length);
          let offset = 0;
          const parts = partsByBody.get(row.current_copy) ?? [];
          for (const part of parts) {
            const chunk = base64ToBytes(part.bytes);
            if (
              Number(part.start_offset) !== offset ||
              await digestContent(chunk) !== part.part_digest
            ) throw new Error("Corrupt database body part.");
            bytes.set(
              chunk.subarray(0, Math.max(0, bytes.length - offset)),
              Math.min(offset, bytes.length),
            );
            offset += chunk.length;
          }
          if (offset < bytes.length) {
            throw new Error("Truncated database body.");
          }
        } else {
          if (!external) {
            throw new Error(
              `An explicit reader is required for backend ${row.backend_id}.`,
            );
          }
          ({ bytes, mediaType } = await external({
            key: row.current_copy,
            kind: row.backend_kind,
            backendId: row.backend_id,
            namespace: row.namespace,
            length: row.terminal.length,
          }));
        }
        const digest = await digestContent(bytes);
        if (
          bytes.length !== row.terminal.length ||
          (row.terminal.digest !== undefined &&
            digest !== row.terminal.digest) ||
          (row.terminal.outcome === "completed" &&
            row.terminal.digest === undefined)
        ) throw new Error("Body integrity check failed.");
        yield {
          bodyId: row.body_id,
          key: row.current_copy,
          namespace: row.namespace,
          backendKind: row.backend_kind,
          backendId: row.backend_id,
          mediaType,
          bytes: bytesToBase64(bytes),
          digest,
          outcome: row.terminal.outcome,
        };
      }
      done = end;
      total += batch.length;
      console.error(`[upgrade:${schema}] verified copies ${total}`);
    }
  }
}
/** Publish fresh schema-prefixed copies atomically with the owning rows. */
export async function installTransferBodies(
  executor: SqlExecutor,
  schema: string,
  bodies: readonly TransferBody[],
): Promise<void> {
  await provisionBodyStoreSchema(executor, schema);
  const tables = createCoreTableNames(schema),
    physical = bodyStoreTables(schema);
  const pending: {
    body_id: string;
    key: string;
    token: string;
    length: number;
    digest: string;
  }[] = [];
  const ids = new Set<string>();
  async function flush() {
    if (!pending.length) return;
    const values = JSON.stringify(pending);
    const records =
      `jsonb_to_recordset($1::jsonb) AS v(body_id text,key text,token text,length bigint,digest text)`;
    await executor.query(
      `UPDATE ${tables.content_copies} c SET state='orphan',collectable=FALSE
       FROM ${records} WHERE c.body_id=v.body_id AND c.state NOT IN ('retiring','retired')`,
      [values],
    );
    await executor.query(
      `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,version_token,state,collectable)
       SELECT key,'database','database:default',body_id,token,'current',TRUE FROM ${records}`,
      [values],
    );
    await executor.query(
      `UPDATE ${tables.content_logical_bodies} b SET current_copy=v.key,committed_offset=v.length,
       seal_intent=CASE WHEN b.seal_intent IS NULL THEN NULL ELSE jsonb_build_object('length',v.length,'digest',v.digest) END,
       terminal=b.terminal || jsonb_build_object('length',v.length,'digest',v.digest)
       FROM ${records} WHERE b.body_id=v.body_id`,
      [values],
    );
    await executor.query(
      `DELETE FROM ${physical.bodies} p USING ${tables.content_copies} c, ${records}
       WHERE c.body_id=v.body_id AND c.backend_kind='database' AND c.copy_key<>v.key AND p.body_id=c.copy_key`,
      [values],
    );
    await executor.query(
      `UPDATE ${tables.content_copies} c SET state='retired',collectable=FALSE
       FROM ${records} WHERE c.body_id=v.body_id AND c.backend_kind='database' AND c.copy_key<>v.key`,
      [values],
    );
    pending.length = 0;
    ids.clear();
  }
  for (const body of bodies) {
    // Preserve sequential replacement semantics even for repeated body IDs.
    if (ids.has(body.bodyId) || pending.length === 1000) await flush();

    const bytes = base64ToBytes(body.bytes);
    if (await digestContent(bytes) !== body.digest) {
      throw new Error("Bundle body integrity check failed.");
    }
    const key = `schemas/${schema}/imported/${crypto.randomUUID()}`,
      token = crypto.randomUUID();
    await executor.query(
      `INSERT INTO ${physical.bodies}(body_id,state,media_type,reservation_id,writer_generation,fenced_from,byte_length,digest,version_token,maintenance_version,updated_at) VALUES($1,$2,$3,$4,1,NULL,$5,$6,$7,1,NOW())`,
      [
        key,
        body.outcome === "completed" ? "ready" : "incomplete",
        body.mediaType,
        crypto.randomUUID(),
        bytes.length,
        body.digest,
        token,
      ],
    );
    for (
      let offset = 0;
      offset < bytes.length;
      offset += BODY_APPEND_MAX_BYTES
    ) {
      const chunk = bytes.slice(offset, offset + BODY_APPEND_MAX_BYTES);
      await executor.query(
        `INSERT INTO ${physical.parts}(body_id,start_offset,append_id,bytes,part_digest) VALUES($1,$2,$3,$4,$5)`,
        [key, offset, `import:${offset}`, chunk, await digestContent(chunk)],
      );
    }
    pending.push({
      body_id: body.bodyId,
      key,
      token,
      length: bytes.length,
      digest: body.digest,
    });
    ids.add(body.bodyId);
  }
  await flush();
}
