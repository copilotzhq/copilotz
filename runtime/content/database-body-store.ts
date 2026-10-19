import {
  assertSchemaCommandTransaction,
  createSchemaCommandRunner,
} from "../engine/commands.ts";
import { type SqlExecutor, validateEventSchemaName } from "../events/index.ts";
import type { BodyStore, BodyStoreAdapter } from "./body-store.ts";
import {
  bodyStoreTables,
  provisionBodyStoreSchema,
  validateBodyStoreSchema,
} from "./body-store-schema.ts";
import {
  bodyConflict,
  bodyUnavailable,
  captureBodyAppend,
  createBodyStoreOperations,
  type StoredBody,
  type StoredVersion,
} from "./body-store-operations.ts";
import { digestContent } from "./digest.ts";
import { base64ToBytes } from "./encoding.ts";

type BodyRow = {
  body_id: string;
  state: StoredBody["state"];
  media_type: string;
  reservation_id: string;
  writer_generation: string | number;
  fenced_from: string | number | null;
  byte_length: string | number;
  digest: StoredBody["digest"];
  version_token: string;
  maintenance_version: string | number;
  updated_at: string;
  parts: StoredBody["parts"];
};
function integer(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) bodyUnavailable();
  return result;
}
function bytesFromSql(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value.startsWith("\\x")) {
    return Uint8Array.from(
      value.slice(2).match(/../g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
  }
  return base64ToBytes(value);
}
function mapRow(row: BodyRow): StoredVersion {
  const body: StoredBody = {
    bodyId: row.body_id,
    state: row.state,
    mediaType: row.media_type,
    reservationId: row.reservation_id,
    generation: integer(row.writer_generation),
    fencedFrom: row.fenced_from === null ? null : integer(row.fenced_from),
    byteLength: integer(row.byte_length),
    digest: row.digest,
    revision: integer(row.maintenance_version),
    nonce: row.version_token,
    updatedAt: new Date(row.updated_at).toISOString(),
    parts: row.parts,
  };
  return { body, versionToken: row.version_token };
}
const provisioners = new WeakMap<BodyStore, () => Promise<void>>();
const writers = new WeakMap<
  BodyStore["put"],
  (transaction: SqlExecutor) => BodyStore
>();
/** Whether the physical adapter uses this runtime's owner-joinable SQL layout. */
export function isDatabaseBodyStore(store: BodyStore): boolean {
  return writers.has(store.put);
}
/** Owner-internal writer bound to the existing command, never a second session. */
export function databaseBodyStoreWriter(
  store: BodyStore,
  transaction: SqlExecutor,
): BodyStore {
  const writer = writers.get(store.put);
  if (store.kind === "database" && !writer) {
    throw new Error(
      "Database body storage cannot join this owner transaction.",
    );
  }
  return writer?.(transaction) ?? store;
}
const readers = new WeakMap<
  BodyStore["readRange"],
  (
    transaction?: SqlExecutor,
    readAuthority?: (databaseSchema: string) => Promise<void>,
  ) => Pick<BodyStore, "readRange">
>();
/** Owner-internal read view: never provisions or submits a nested command. */
export function databaseBodyStoreReader(
  store: BodyStore,
  transaction?: SqlExecutor,
  readAuthority?: (databaseSchema: string) => Promise<void>,
): Pick<BodyStore, "readRange"> {
  return readers.get(store.readRange)?.(transaction, readAuthority) ??
    { readRange: store.readRange };
}
export async function provisionDatabaseBodyStore(
  store: BodyStore,
): Promise<boolean> {
  const provision = provisioners.get(store);
  if (!provision) return false;
  await provision();
  return true;
}
export function createDatabaseBodyStoreAdapter(
  options: Readonly<{ session: SqlExecutor; backendId?: string }>,
): BodyStoreAdapter {
  const stores = new Map<string, BodyStore>();
  const storeFor = (schema: string) => {
    let store = stores.get(schema);
    if (!store) {
      store = createDatabaseBodyStore({ ...options, schema });
      stores.set(schema, store);
    }
    return store;
  };
  return {
    deployment: {
      durability: "durable",
      reach: "cluster",
      readyGarbageCollection: true,
    },
    forScope(scope) {
      return storeFor(scope.databaseSchema);
    },
    maintenanceForScope(scope) {
      return storeFor(scope.databaseSchema).maintenance;
    },
  };
}
/** Database bytes, governed exclusively by identity/generation/version CAS. */
export function createDatabaseBodyStore(
  options: Readonly<
    {
      session: SqlExecutor;
      schema: string;
      backendId?: string;
      provisioned?: boolean;
    }
  >,
): BodyStore {
  const session = options.session,
    schemaName = validateEventSchemaName(options.schema.trim()),
    { bodies, parts } = bodyStoreTables(schemaName);
  const runCommand = createSchemaCommandRunner(session, schemaName);
  let ready: Promise<void> | undefined;
  const ensure = () =>
    ready ??= (options.provisioned
      ? validateBodyStoreSchema(session, schemaName)
      : runCommand("body.provision", {}, async (_, { transaction }) =>
        await provisionBodyStoreSchema(transaction, schemaName)))
      .catch((error) => {
        ready = undefined;
        throw error;
      });
  const selection = `SELECT body.*,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('appendId',part.append_id,'offset',part.start_offset,'length',octet_length(part.bytes),'digest',part.part_digest) ORDER BY part.start_offset) FROM ${parts} part WHERE part.body_id=body.body_id),'[]'::jsonb) AS parts FROM ${bodies} body`;
  const operations = createBodyStoreOperations({
    kind: "database",
    backendId: options.backendId?.trim() || "database:default",
    conditionalDelete: true,
    async load(bodyId) {
      await ensure();
      const rows = await session.query<BodyRow>(
        `${selection} WHERE body.body_id=$1`,
        [bodyId],
      );
      return rows.rows[0] ? mapRow(rows.rows[0]) : null;
    },
    async compareAndSwap(body, previous, writes) {
      await ensure();
      return await runCommand("body.cas", {}, async (_, { transaction }) => {
        const values = [
          body.bodyId,
          body.state,
          body.mediaType,
          body.reservationId,
          body.generation,
          body.fencedFrom,
          body.byteLength,
          body.digest,
          body.nonce,
          body.revision,
          body.updatedAt,
        ];
        const mutation = previous === null
          ? `INSERT INTO ${bodies}(body_id,state,media_type,reservation_id,writer_generation,fenced_from,byte_length,digest,version_token,maintenance_version,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(body_id) DO NOTHING RETURNING body_id`
          : `UPDATE ${bodies} SET state=$2,media_type=$3,reservation_id=$4,writer_generation=$5,fenced_from=$6,byte_length=$7,digest=$8,version_token=$9,maintenance_version=$10,updated_at=$11 WHERE body_id=$1 AND version_token=$12 RETURNING body_id`;
        const params: unknown[] = previous === null
          ? values
          : [...values, previous];
        const rows = writes.map(({ part, bytes }) =>
          `($${params.push(part.offset)}::bigint,$${
            params.push(part.appendId)
          }::text,$${params.push(bytes)}::bytea,$${
            params.push(part.digest)
          }::text)`
        );
        const result = await transaction.query(
          rows.length
            ? `WITH changed AS (${mutation}), inserted_parts AS (
            INSERT INTO ${parts}(body_id,start_offset,append_id,bytes,part_digest)
            SELECT changed.body_id,part.start_offset,part.append_id,part.bytes,part.digest
            FROM changed,(VALUES ${
              rows.join(",")
            }) AS part(start_offset,append_id,bytes,digest)
          ) SELECT body_id FROM changed`
            : mutation,
          params,
        );
        if (!result.rows.length) return false;
        return body.nonce;
      });
    },
    async readRange(stored, start, end) {
      await ensure();
      const result = await session.query<
        {
          start_offset: string | number | null;
          part_length: string | number | null;
          bytes: Uint8Array | ArrayBuffer | string | null;
        }
      >(
        `SELECT part.* FROM ${bodies} body LEFT JOIN LATERAL (
        WITH anchor AS (SELECT start_offset FROM ${parts} WHERE body_id=body.body_id AND start_offset<=$2 ORDER BY start_offset DESC LIMIT 1)
        SELECT start_offset,octet_length(bytes) AS part_length,
          substring(bytes FROM (GREATEST($2::bigint-start_offset,0)+1)::integer FOR (LEAST($3::bigint-start_offset,octet_length(bytes))-GREATEST($2::bigint-start_offset,0))::integer) AS bytes
        FROM ${parts} WHERE body_id=body.body_id AND $3::bigint>$2::bigint AND start_offset>=COALESCE((SELECT start_offset FROM anchor),$2::bigint) AND start_offset<$3::bigint ORDER BY start_offset
      ) part ON TRUE WHERE body.body_id=$1 AND body.reservation_id=$4 AND COALESCE(body.fenced_from,body.writer_generation)=$5 AND body.byte_length>=$3 AND body.state<>'aborted' ORDER BY part.start_offset`,
        [
          stored.body.bodyId,
          start,
          end,
          stored.body.reservationId,
          stored.body.fencedFrom ?? stored.body.generation,
        ],
      );
      if (!result.rows.length) bodyConflict();
      const output = new Uint8Array(end - start);
      let cursor = start;
      for (const row of result.rows) {
        if (
          row.start_offset === null || row.part_length === null ||
          row.bytes === null
        ) continue;
        const partStart = integer(row.start_offset),
          partEnd = partStart + integer(row.part_length),
          from = Math.max(start, partStart),
          to = Math.min(end, partEnd),
          bytes = bytesFromSql(row.bytes);
        if (from !== cursor || to < from || bytes.length !== to - from) {
          bodyUnavailable(
            "Database body range has missing or overlapping parts.",
          );
        }
        output.set(bytes, from - start);
        cursor = to;
      }
      if (cursor !== end) bodyUnavailable("Database body range is truncated.");
      return output;
    },
    async list(input) {
      await ensure();
      const result = await session.query<BodyRow>(
        `${selection} WHERE body.body_id>$1 AND left(body.body_id,length($2))=$2 ORDER BY body.body_id LIMIT $3`,
        [input.after, input.prefix, input.limit],
      );
      return result.rows.map(mapRow);
    },
    async delete(stored) {
      await ensure();
      return await runCommand("body.delete", {}, async (_, { transaction }) => {
        const result = await transaction.query(
          `DELETE FROM ${bodies} WHERE body_id=$1 AND version_token=$2 RETURNING body_id`,
          [stored.body.bodyId, stored.versionToken],
        );
        return result.rows.length === 1;
      });
    },
  });
  const store: BodyStore = {
    ...operations,
    append: async (raw) => {
      const input = captureBodyAppend(raw);
      await ensure();
      return await runCommand(
        "body.append",
        {},
        async (_, { transaction }) =>
          await appendDatabaseBody(transaction, schemaName, input),
      );
    },
  };
  readers.set(
    store.readRange,
    (transaction, readAuthority) => {
      const reader = createDatabaseBodyStore({
        ...options,
        session: transaction ?? session,
        provisioned: true,
      });
      return {
        async readRange(input) {
          if (readAuthority) await readAuthority(schemaName);
          else if (transaction) {
            assertSchemaCommandTransaction(transaction, schemaName);
          }
          const result = await reader.readRange(input);
          if (readAuthority) await readAuthority(schemaName);
          else if (transaction) {
            assertSchemaCommandTransaction(transaction, schemaName);
          }
          return result;
        },
      };
    },
  );
  writers.set(store.put, (transaction) => {
    assertSchemaCommandTransaction(transaction, schemaName);
    return createDatabaseBodyStore({ ...options, session: transaction });
  });
  provisioners.set(store, ensure);
  return store;
}

/** Physical bytes join the checkpoint transaction and its rollback boundary. */
export async function appendDatabaseBody(
  transaction: SqlExecutor,
  schema: string,
  raw: import("./body-store.ts").AppendBodyInput,
): Promise<import("./body-store.ts").AppendResult> {
  assertSchemaCommandTransaction(transaction, schema);
  const { bodies, parts } = bodyStoreTables(schema);
  const input = captureBodyAppend(raw),
    digest = await digestContent(input.bytes);
  const result = await transaction.query<{ version_token: string }>(
    `
        WITH current AS (
          SELECT body.*,part.start_offset,part.bytes,part.part_digest
          FROM ${bodies} body LEFT JOIN ${parts} part
            ON part.body_id=body.body_id AND part.append_id=$6
          WHERE body.body_id=$1 AND body.reservation_id=$2 AND body.writer_generation=$3
            AND body.media_type=$4 AND body.state='open' AND body.fenced_from IS NULL
        ), changed AS (
          UPDATE ${bodies} SET byte_length=$5::bigint+octet_length($7::bytea),
            version_token=$9,maintenance_version=maintenance_version+1,updated_at=NOW()
          WHERE body_id=$1 AND EXISTS (SELECT 1 FROM current WHERE start_offset IS NULL AND byte_length=$5)
          RETURNING version_token
        ), inserted AS (
          INSERT INTO ${parts}(body_id,start_offset,append_id,bytes,part_digest)
          SELECT $1,$5,$6,$7,$8 FROM changed RETURNING body_id
        )
        SELECT version_token FROM changed WHERE EXISTS(SELECT 1 FROM inserted)
        UNION ALL SELECT version_token FROM current
          WHERE start_offset=$5 AND bytes=$7::bytea AND part_digest=$8
            AND byte_length >= $5::bigint+octet_length($7::bytea)`,
    [
      input.writer.bodyId,
      input.writer.reservationId,
      input.writer.generation,
      input.writer.mediaType,
      input.expectedOffset,
      input.appendId,
      input.bytes,
      digest,
      crypto.randomUUID(),
    ],
  );
  if (!result.rows.length) bodyConflict();
  return Object.freeze({
    startOffset: input.expectedOffset,
    endOffset: input.expectedOffset + input.bytes.length,
    versionToken: result.rows[0].version_token,
  });
}
