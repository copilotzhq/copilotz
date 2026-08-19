import {
  quoteEventIdentifier,
  type SqlExecutor,
  validateEventSchemaName,
} from "../events/index.ts";
import type {
  AssetBodyHead,
  AssetBodySpill,
  AssetBodySpillHead,
  AssetBodyStore,
  PutAssetBodyInput,
} from "./body-store.ts";
import { base64ToBytes, bytesToBase64 } from "./encoding.ts";
import { createContentError } from "./errors.ts";

function validateHead(
  expected: PutAssetBodyInput,
  actual: AssetBodyHead,
): void {
  if (
    actual.byteLength !== expected.bytes.byteLength ||
    actual.digest !== expected.digest || actual.mediaType !== expected.mediaType
  ) {
    throw createContentError(
      "asset_conflict",
      "Stored asset body conflicts with the canonical asset metadata.",
    );
  }
}

type BodyRow = {
  key: string;
  media_type: string;
  digest: string;
  byte_length: string | number;
  body: string;
  etag: string | null;
  last_modified: string;
};

type StagingRow = {
  key: string;
  media_type: string;
  byte_length: string | number;
  discarded: string | number;
  body: string;
  reservation_id: string | null;
};

function asInteger(value: string | number, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw createContentError(
      "asset_corrupted",
      `Database asset ${name} is invalid.`,
    );
  }
  return parsed;
}

function mapHead(row: BodyRow): AssetBodyHead {
  return Object.freeze({
    key: row.key,
    byteLength: asInteger(row.byte_length, "byte length"),
    mediaType: row.media_type,
    digest: row.digest as `sha256:${string}`,
    ...(row.etag ? { etag: row.etag } : {}),
    lastModified: row.last_modified,
  });
}

function mapSpill(row: StagingRow): AssetBodySpillHead {
  return Object.freeze({
    key: row.key,
    mediaType: row.media_type,
    byteLength: asInteger(row.byte_length, "byte length"),
    discarded: asInteger(row.discarded, "discarded offset"),
    reservationId: row.reservation_id ?? "",
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** SQL body store for progressive spill. Not the graph `nodes.content` path. */
export function createDatabaseAssetBodyStore(
  options: Readonly<{
    session: SqlExecutor;
    schema: string;
    backendId?: string;
  }>,
): AssetBodyStore {
  const session = options.session;
  const backendId = options.backendId?.trim() || "database:default";
  const schema = quoteEventIdentifier(
    validateEventSchemaName(options.schema.trim()),
  );
  const bodies = `${schema}."asset_bodies"`;
  const staging = `${schema}."asset_body_staging"`;
  let ready: Promise<void> | undefined;
  const ensure = () => {
    ready ??= (async () => {
      await session.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${bodies} (
          key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          digest TEXT NOT NULL,
          byte_length BIGINT NOT NULL,
          body TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT NOT NULL
        )`,
      );
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${staging} (
          key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          byte_length BIGINT NOT NULL,
          discarded BIGINT NOT NULL,
          body TEXT NOT NULL,
          reservation_id TEXT NOT NULL
        )`,
      );
      await session.query(
        `ALTER TABLE ${staging}
         ADD COLUMN IF NOT EXISTS reservation_id TEXT`,
      );
    })();
    return ready;
  };

  const loadStaging = async (key: string): Promise<StagingRow | null> => {
    await ensure();
    const result = await session.query<StagingRow>(
      `SELECT key, media_type, byte_length, discarded, body, reservation_id
         FROM ${staging} WHERE key = $1 LIMIT 1`,
      [key],
    );
    return result.rows[0] ?? null;
  };

  const writeStaging = async (
    row: Readonly<{
      key: string;
      mediaType: string;
      byteLength: number;
      discarded: number;
      bytes: Uint8Array;
      reservationId: string;
    }>,
  ): Promise<AssetBodySpillHead> => {
    await ensure();
    const updated = await session.query<StagingRow>(
      `UPDATE ${staging}
       SET media_type = $2,
           byte_length = $3,
           discarded = $4,
           body = $5
       WHERE key = $1 AND reservation_id = $6
       RETURNING key, media_type, byte_length, discarded, body, reservation_id`,
      [
        row.key,
        row.mediaType,
        row.byteLength,
        row.discarded,
        bytesToBase64(row.bytes),
        row.reservationId,
      ],
    );
    if (updated.rows[0]) return mapSpill(updated.rows[0]);
    const existing = await loadStaging(row.key);
    throw createContentError(
      existing ? "asset_conflict" : "asset_not_found",
      existing
        ? "Progressive writer no longer owns this asset body."
        : "Progressive staging was not found.",
    );
  };

  const requireOwner = (
    row: StagingRow,
    reservationId: string,
  ): void => {
    if (row.reservation_id !== reservationId) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this asset body.",
      );
    }
  };

  const spill: AssetBodySpill = {
    async reserve(input) {
      await ensure();
      const inserted = await session.query<StagingRow>(
        `INSERT INTO ${staging}
           (key, media_type, byte_length, discarded, body, reservation_id)
         VALUES ($1, $2, 0, 0, $3, $4)
         ON CONFLICT (key) DO NOTHING
         RETURNING key, media_type, byte_length, discarded, body, reservation_id`,
        [
          input.key,
          input.mediaType,
          bytesToBase64(new Uint8Array()),
          input.reservationId,
        ],
      );
      if (inserted.rows[0]) return mapSpill(inserted.rows[0]);
      const existing = await loadStaging(input.key);
      if (!existing) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer reservation raced with another owner.",
        );
      }
      if (existing.media_type !== input.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      if (!input.takeover) {
        throw createContentError(
          "asset_conflict",
          "A progressive writer already owns this asset body.",
        );
      }
      const claimed = await session.query<StagingRow>(
        `UPDATE ${staging}
         SET reservation_id = $2
         WHERE key = $1 AND reservation_id IS NOT DISTINCT FROM $3
         RETURNING key, media_type, byte_length, discarded, body, reservation_id`,
        [input.key, input.reservationId, existing.reservation_id],
      );
      if (!claimed.rows[0]) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer reservation raced with another owner.",
        );
      }
      return mapSpill(claimed.rows[0]);
    },
    async head(key) {
      const row = await loadStaging(key);
      return row ? mapSpill(row) : null;
    },
    async append(input) {
      const existing = await loadStaging(input.key);
      if (!existing) {
        throw createContentError(
          "asset_not_found",
          "Progressive staging was not found.",
        );
      }
      requireOwner(existing, input.reservationId);
      if (existing && existing.media_type !== input.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      const previous = existing
        ? base64ToBytes(existing.body)
        : new Uint8Array();
      const discarded = asInteger(existing.discarded, "discarded offset");
      const bytes = input.bytes.byteLength === 0
        ? previous
        : concatBytes([previous, input.bytes]);
      return await writeStaging({
        key: input.key,
        mediaType: input.mediaType,
        byteLength: asInteger(existing.byte_length, "byte length") +
          input.bytes.byteLength,
        discarded,
        bytes,
        reservationId: input.reservationId,
      });
    },
    async read(input) {
      const row = await loadStaging(input.key);
      if (!row) {
        throw createContentError(
          "asset_not_found",
          "Progressive staging was not found.",
        );
      }
      const head = mapSpill(row);
      const start = Math.max(input.offset, head.discarded);
      const end = Math.min(input.end, head.byteLength);
      if (end <= start) return new Uint8Array();
      const physical = start - head.discarded;
      return base64ToBytes(row.body).subarray(
        physical,
        physical + (end - start),
      );
    },
    async truncate(key, byteLength, reservationId) {
      const row = await loadStaging(key);
      if (!row) {
        throw createContentError(
          "asset_not_found",
          "Progressive staging was not found.",
        );
      }
      requireOwner(row, reservationId);
      const head = mapSpill(row);
      if (byteLength < head.discarded || byteLength > head.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive truncate is outside the committed range.",
        );
      }
      const kept = base64ToBytes(row.body).subarray(
        0,
        byteLength - head.discarded,
      );
      return await writeStaging({
        key,
        mediaType: head.mediaType,
        byteLength,
        discarded: head.discarded,
        bytes: kept,
        reservationId,
      });
    },
    async discardPrefix(key, byteLength, reservationId) {
      const row = await loadStaging(key);
      if (!row) {
        throw createContentError(
          "asset_not_found",
          "Progressive staging was not found.",
        );
      }
      requireOwner(row, reservationId);
      const head = mapSpill(row);
      if (byteLength < head.discarded || byteLength > head.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive discard is outside the committed range.",
        );
      }
      const kept = base64ToBytes(row.body).subarray(
        byteLength - head.discarded,
      );
      return await writeStaging({
        key,
        mediaType: head.mediaType,
        byteLength: head.byteLength,
        discarded: byteLength,
        bytes: kept,
        reservationId,
      });
    },
    async delete(key, reservationId) {
      await ensure();
      const removed = await session.query<{ key: string }>(
        `DELETE FROM ${staging}
         WHERE key = $1 AND reservation_id = $2
         RETURNING key`,
        [key, reservationId],
      );
      if (removed.rows[0]) return;
      const existing = await loadStaging(key);
      if (existing) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this asset body.",
        );
      }
    },
  };

  const store: AssetBodyStore = {
    kind: "database",
    backendId,
    async put(input) {
      await ensure();
      const existing = await session.query<BodyRow>(
        `SELECT * FROM ${bodies} WHERE key = $1 LIMIT 1`,
        [input.key],
      );
      if (existing.rows[0]) {
        const head = mapHead(existing.rows[0]);
        validateHead(input, head);
        return head;
      }
      const lastModified = new Date().toISOString();
      const etag = input.digest.slice("sha256:".length);
      await session.query(
        `INSERT INTO ${bodies}
           (key, media_type, digest, byte_length, body, etag, last_modified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.key,
          input.mediaType,
          input.digest,
          input.bytes.byteLength,
          bytesToBase64(input.bytes),
          etag,
          lastModified,
        ],
      );
      return Object.freeze({
        key: input.key,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        etag,
        lastModified,
      });
    },
    async head(key) {
      await ensure();
      const result = await session.query<BodyRow>(
        `SELECT * FROM ${bodies} WHERE key = $1 LIMIT 1`,
        [key],
      );
      return result.rows[0] ? mapHead(result.rows[0]) : null;
    },
    async read(key) {
      await ensure();
      const result = await session.query<BodyRow>(
        `SELECT * FROM ${bodies} WHERE key = $1 LIMIT 1`,
        [key],
      );
      if (!result.rows[0]) {
        throw createContentError(
          "asset_not_found",
          "Asset body was not found in the configured database backend.",
        );
      }
      return base64ToBytes(result.rows[0].body);
    },
    async open(key) {
      const bytes = await store.read(key);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async delete(key) {
      await ensure();
      await session.query(`DELETE FROM ${bodies} WHERE key = $1`, [key]);
    },
    async *list(listOptions = {}) {
      await ensure();
      const prefix = listOptions.prefix ?? "";
      const listed = await session.query<BodyRow>(
        `SELECT * FROM ${bodies} ORDER BY key`,
      );
      for (const row of listed.rows) {
        if (row.key.startsWith(prefix)) yield mapHead(row);
      }
    },
    spill,
  };
  return Object.freeze(store);
}
