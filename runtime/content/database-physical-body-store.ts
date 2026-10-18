/** Private physical bytes. Catalog authority and protection belong to the owner. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createContentError } from "./errors.ts";
import { base64ToBytes } from "./encoding.ts";
import {
  capturePhysicalAppend,
  capturePhysicalIdentity,
  capturePhysicalRange,
  OWNER_PHYSICAL_BODY_FORMAT,
  type PhysicalBodyHead,
  type PhysicalBodyStore,
  physicalIdentifier,
  type PhysicalWriterIdentity,
  samePhysicalWriter,
} from "./physical-body-store.ts";
import {
  physicalBodyTables,
  validatePhysicalBodySchema,
} from "./physical-body-schema.ts";

type Row = {
  body_id: string;
  format: string;
  state: string;
  media_type: string;
  reservation_id: string;
  writer_generation: string | number;
  byte_length: string | number;
  version_token: string;
};
const fields =
  "body_id,format,state,media_type,reservation_id,writer_generation,byte_length,version_token";
function conflict(): never {
  throw createContentError(
    "asset_conflict",
    "Physical writer identity, state or offset conflicts.",
  );
}
function corrupted(): never {
  throw createContentError(
    "asset_corrupted",
    "Physical body metadata or bytes are invalid.",
  );
}
function integer(value: unknown): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(n) || n < 0) corrupted();
  return n;
}
function identity(row: Row): PhysicalWriterIdentity {
  try {
    return capturePhysicalIdentity({
      bodyId: row.body_id,
      mediaType: row.media_type,
      reservationId: row.reservation_id,
      generation: integer(row.writer_generation),
    });
  } catch {
    return corrupted();
  }
}
function head(row: Row): PhysicalBodyHead {
  if (
    row.format !== OWNER_PHYSICAL_BODY_FORMAT ||
    !["open", "fenced"].includes(row.state)
  ) corrupted();
  const writer = identity(row);
  let token: string;
  try {
    token = physicalIdentifier(row.version_token);
  } catch {
    return corrupted();
  }
  return Object.freeze({
    ...writer,
    format: OWNER_PHYSICAL_BODY_FORMAT,
    state: row.state as "open" | "fenced",
    generation: writer.generation + (row.state === "fenced" ? 1 : 0),
    byteLength: integer(row.byte_length),
    versionToken: token,
  });
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      const hex = value.slice(2);
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) corrupted();
      return Uint8Array.from(
        hex.match(/../g) ?? [],
        (value) => parseInt(value, 16),
      );
    }
    try {
      return base64ToBytes(value);
    } catch {
      return corrupted();
    }
  }
  return corrupted();
}

/** Reopens an explicitly provisioned exact format; never provisions or repairs it. */
export async function createDatabasePhysicalBodyStore(
  options: Readonly<{
    session: SqlSession;
    schema: string;
  }>,
): Promise<PhysicalBodyStore> {
  const { session, schema } = options;
  const transactionCapability = session.transaction;
  if (typeof transactionCapability !== "function") {
    throw createContentError(
      "asset_storage_unavailable",
      "Physical storage requires atomic transactions.",
    );
  }
  const transaction = transactionCapability.bind(session);
  const query = session.query.bind(session);
  const { bodies, parts } = physicalBodyTables(schema);
  await validatePhysicalBodySchema({ query }, schema);
  const load = async (
    tx: SqlExecutor,
    bodyId: string,
    lock = false,
  ): Promise<Row | null> => {
    const result = await tx.query<Row>(
      `SELECT ${fields} FROM ${bodies} WHERE body_id=$1${
        lock ? " FOR UPDATE" : ""
      }`,
      [bodyId],
    );
    const row = result.rows[0] ?? null;
    if (row) head(row);
    return row;
  };
  const insert = async (
    tx: SqlExecutor,
    writer: PhysicalWriterIdentity,
    state: "open" | "fenced",
  ) => {
    await tx.query(
      `INSERT INTO ${bodies} (${fields}) VALUES ($1,$2,$3,$4,$5,$6,0,$7)
      ON CONFLICT (body_id) DO NOTHING`,
      [
        writer.bodyId,
        OWNER_PHYSICAL_BODY_FORMAT,
        state,
        writer.mediaType,
        writer.reservationId,
        writer.generation,
        crypto.randomUUID(),
      ],
    );
  };
  const requireWriter = (
    row: Row | null,
    writer: PhysicalWriterIdentity,
  ): Row => {
    if (!row || !samePhysicalWriter(identity(row), writer)) conflict();
    return row;
  };
  return Object.freeze(
    {
      async reserve(input) {
        const writer = capturePhysicalIdentity(input);
        return await transaction(async (tx) => {
          await insert(tx, writer, "open");
          const row = requireWriter(
            await load(tx, writer.bodyId, true),
            writer,
          );
          if (row.state !== "open") conflict();
          return head(row);
        });
      },
      async append(input) {
        const request = capturePhysicalAppend(input);
        return await transaction(async (tx) => {
          const row = requireWriter(
            await load(tx, request.writer.bodyId, true),
            request.writer,
          );
          if (row.state !== "open") conflict();
          const previous = await tx.query<
            { start_offset: string | number; bytes: unknown }
          >(
            `SELECT start_offset,bytes FROM ${parts} WHERE body_id=$1 AND append_id=$2`,
            [request.writer.bodyId, request.appendId],
          );
          if (previous.rows[0]) {
            const previousBytes = bytes(previous.rows[0].bytes);
            const previousOffset = integer(previous.rows[0].start_offset);
            if (
              previousOffset + previousBytes.byteLength >
                integer(row.byte_length)
            ) corrupted();
            if (
              integer(previous.rows[0].start_offset) !==
                request.expectedOffset ||
              previousBytes.byteLength !== request.bytes.byteLength ||
              !previousBytes.every((value, index) =>
                value === request.bytes[index]
              )
            ) conflict();
            return Object.freeze({
              startOffset: request.expectedOffset,
              endOffset: integer(row.byte_length),
              versionToken: row.version_token,
            });
          }
          if (integer(row.byte_length) !== request.expectedOffset) conflict();
          await tx.query(
            `INSERT INTO ${parts} (body_id,start_offset,append_id,bytes) VALUES ($1,$2,$3,$4)`,
            [
              request.writer.bodyId,
              request.expectedOffset,
              request.appendId,
              request.bytes,
            ],
          );
          const end = request.expectedOffset + request.bytes.byteLength;
          const changed = await tx.query<Row>(
            `UPDATE ${bodies} SET byte_length=$2,version_token=$3
          WHERE body_id=$1 AND format=$4 AND state='open' AND reservation_id=$5 AND writer_generation=$6
          AND byte_length=$7 RETURNING ${fields}`,
            [
              request.writer.bodyId,
              end,
              crypto.randomUUID(),
              OWNER_PHYSICAL_BODY_FORMAT,
              request.writer.reservationId,
              request.writer.generation,
              request.expectedOffset,
            ],
          );
          if (!changed.rows[0]) conflict(); // Throwing rolls back the inserted part too.
          const result = head(changed.rows[0]);
          return Object.freeze({
            startOffset: request.expectedOffset,
            endOffset: result.byteLength,
            versionToken: result.versionToken,
          });
        });
      },
      async fence(input) {
        const writer = capturePhysicalIdentity(input);
        return await transaction(async (tx) => {
          await insert(tx, writer, "fenced");
          const row = requireWriter(
            await load(tx, writer.bodyId, true),
            writer,
          );
          if (row.state === "fenced") return head(row);
          const changed = await tx.query<Row>(
            `UPDATE ${bodies} SET state='fenced',version_token=$2
          WHERE body_id=$1 AND format=$3 AND state='open' AND reservation_id=$4 AND writer_generation=$5
          RETURNING ${fields}`,
            [
              writer.bodyId,
              crypto.randomUUID(),
              OWNER_PHYSICAL_BODY_FORMAT,
              writer.reservationId,
              writer.generation,
            ],
          );
          if (!changed.rows[0]) conflict();
          return head(changed.rows[0]);
        });
      },
      async head(bodyId) {
        const row = await load({ query }, physicalIdentifier(bodyId));
        return row ? head(row) : null;
      },
      async readRange(input) {
        const range = capturePhysicalRange(input);
        // One SQL snapshot reads the head and indexed overlapping immutable parts.
        // Only the requested bytes cross SQL; the catalog later limits accepted prefixes.
        const result = await query<
          Row & {
            start_offset: string | number | null;
            part_length: string | number | null;
            bytes: unknown;
          }
        >(
          `SELECT body.*,part.* FROM ${bodies} body LEFT JOIN LATERAL (
          WITH anchor AS (SELECT start_offset FROM ${parts} WHERE body_id=body.body_id AND start_offset<=$2
            ORDER BY start_offset DESC LIMIT 1),
          selected AS MATERIALIZED (
            SELECT start_offset,octet_length(bytes) AS part_length,
              GREATEST(start_offset,$2) AS from_offset,
              LEAST(start_offset+octet_length(bytes),$3) AS to_offset
            FROM ${parts} WHERE body_id=body.body_id AND $3>$2 AND $3<=body.byte_length
              AND start_offset>=COALESCE((SELECT start_offset FROM anchor),$2) AND start_offset<$3
          ), spans AS (
            SELECT *,lag(to_offset,1,$2) OVER (ORDER BY start_offset) AS previous_end FROM selected
          ), valid AS (
            SELECT bool_and(from_offset=previous_end AND to_offset>=from_offset)
              AND min(from_offset)=$2 AND max(to_offset)=$3 AS complete FROM spans
          )
          SELECT selected.start_offset,selected.part_length,
            substring(payload.bytes FROM (selected.from_offset-selected.start_offset+1)::integer
              FOR (selected.to_offset-selected.from_offset)::integer) AS bytes
          FROM selected JOIN ${parts} payload
            ON payload.body_id=body.body_id AND payload.start_offset=selected.start_offset
          CROSS JOIN valid WHERE valid.complete
          ORDER BY selected.start_offset
        ) part ON TRUE WHERE body.body_id=$1 ORDER BY part.start_offset`,
          [range.bodyId, range.offset, range.end],
        );
        const row = result.rows[0];
        if (!row) {
          throw createContentError(
            "asset_not_found",
            "Physical body was not found.",
          );
        }
        const current = head(row);
        if (range.end > current.byteLength) conflict();
        const output = new Uint8Array(range.end - range.offset);
        let position = range.offset;
        for (const part of result.rows) {
          if (part.start_offset === null || part.part_length === null) continue;
          const start = integer(part.start_offset),
            length = integer(part.part_length);
          const from = Math.max(start, range.offset),
            to = Math.min(start + length, range.end);
          const chunk = bytes(part.bytes);
          if (
            from !== position || to < from || chunk.byteLength !== to - from
          ) corrupted();
          output.set(chunk, from - range.offset);
          position = to;
        }
        if (position !== range.end) corrupted();
        return output;
      },
    } satisfies PhysicalBodyStore,
  );
}
