import {
  quoteEventIdentifier,
  type SqlExecutor,
  validateEventSchemaName,
} from "../events/index.ts";
import type {
  AbortBodyInput,
  AppendBodyInput,
  AppendResult,
  BodyHead,
  BodyStore,
  BodyStoreAdapter,
  MutableBodyHead,
  PutBodyInput,
  ReadBodyRangeInput,
  ReserveBodyInput,
  WriterCapability,
} from "./body-store.ts";
import {
  bodyProtectionMs,
  bodyProtectionUntil,
  readBodyBytes,
  resolveBodyProtectionUntil,
  writerCapabilityFromHead,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { base64ToBytes } from "./encoding.ts";
import { createContentError } from "./errors.ts";

function validateHead(expected: PutBodyInput, actual: BodyHead): void {
  if (
    actual.bodyId !== expected.bodyId ||
    actual.byteLength !== expected.bytes.byteLength ||
    actual.digest !== expected.digest || actual.mediaType !== expected.mediaType
  ) {
    throw createContentError(
      "asset_conflict",
      "Stored body conflicts with the canonical metadata.",
    );
  }
}

type BodyRow = {
  body_id: string;
  state: "open" | "sealing" | "ready" | "aborted";
  media_type: string;
  byte_length: string | number;
  digest: string | null;
  writer_generation: string | number | null;
  writer_token_hash: string | null;
  lease_expires_at: string | null;
  protected_until: string | null;
  maintenance_version: string | number;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
};

type PartRow = {
  start_offset: string | number;
  append_id: string;
  bytes: Uint8Array | ArrayBuffer | string;
};

type ProgressiveBodyOps = Readonly<{
  reserve(input: ReserveBodyInput): Promise<WriterCapability>;
  head(bodyId: string): Promise<MutableBodyHead | null>;
  append(input: AppendBodyInput): Promise<AppendResult>;
  readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
  abort(input: AbortBodyInput): Promise<void>;
}>;

function asInteger(value: string | number | null, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw createContentError(
      "asset_corrupted",
      `Database body ${name} is invalid.`,
    );
  }
  return parsed;
}

function bytesFromSql(value: PartRow["bytes"]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      const hex = value.slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
    return base64ToBytes(value);
  }
  return new Uint8Array();
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

function mapHead(row: BodyRow): BodyHead {
  if (row.state !== "ready" || !row.digest) {
    throw createContentError(
      "asset_corrupted",
      `Database body '${row.body_id}' is not ready.`,
    );
  }
  return Object.freeze({
    bodyId: row.body_id,
    state: "ready" as const,
    byteLength: asInteger(row.byte_length, "byte length"),
    mediaType: row.media_type,
    digest: row.digest as `sha256:${string}`,
    maintenanceVersion: asInteger(
      row.maintenance_version,
      "maintenance version",
    ),
    ...(row.protected_until ? { protectedUntil: row.protected_until } : {}),
    etag: row.digest.slice("sha256:".length),
    lastModified: row.updated_at,
  });
}

function mapSpill(row: BodyRow): MutableBodyHead {
  const state = row.state === "sealing"
    ? "sealing"
    : row.state === "aborted"
    ? "aborted"
    : "open";
  const byteLength = asInteger(row.byte_length, "byte length");
  const maintenanceVersion = asInteger(
    row.maintenance_version,
    "maintenance version",
  );
  if (state === "aborted") {
    return Object.freeze({
      bodyId: row.body_id,
      state,
      mediaType: row.media_type,
      byteLength,
      discarded: 0,
      maintenanceVersion,
      reservationId: row.writer_token_hash ?? "",
    });
  }
  return Object.freeze({
    bodyId: row.body_id,
    state,
    mediaType: row.media_type,
    byteLength,
    discarded: 0,
    maintenanceVersion,
    reservationId: row.writer_token_hash ?? "",
    writerGeneration: asInteger(
      row.writer_generation ?? 0,
      "writer generation",
    ),
    writerLeaseRemainingMs: row.lease_expires_at
      ? Math.max(0, Date.parse(row.lease_expires_at) - Date.now())
      : 0,
  });
}

function mapAnyHead(row: BodyRow): BodyHead | MutableBodyHead {
  return row.state === "ready" ? mapHead(row) : mapSpill(row);
}

export function createDatabaseBodyStoreAdapter(
  options: Readonly<{
    session: SqlExecutor;
    backendId?: string;
    protectionMs?: number;
  }>,
): BodyStoreAdapter {
  const backendId = options.backendId?.trim() || "database:default";
  const protectionMs = bodyProtectionMs(options.protectionMs);
  const stores = new Map<string, BodyStore>();
  const storeFor = (databaseSchema: string): BodyStore => {
    const schema = databaseSchema.trim();
    if (!schema) {
      throw new TypeError("BodyStore scope requires databaseSchema.");
    }
    const existing = stores.get(schema);
    if (existing) return existing;
    const created = createDatabaseBodyStore({
      session: options.session,
      schema,
      backendId,
      protectionMs,
    });
    stores.set(schema, created);
    return created;
  };
  return Object.freeze({
    deployment: Object.freeze({
      durability: "durable" as const,
      reach: "cluster" as const,
      minimumProtectionMs: protectionMs,
      readyGarbageCollection: true,
    }),
    forScope(scope) {
      return storeFor(scope.databaseSchema);
    },
    maintenanceForScope(scope) {
      return storeFor(scope.databaseSchema).maintenance;
    },
  });
}

/** SQL BodyStore using the final content_bodies/content_body_parts layout. */
export function createDatabaseBodyStore(
  options: Readonly<{
    session: SqlExecutor;
    schema: string;
    backendId?: string;
    protectionMs?: number;
  }>,
): BodyStore {
  const session = options.session;
  const backendId = options.backendId?.trim() || "database:default";
  const protectionMs = bodyProtectionMs(options.protectionMs);
  const deadline = () => bodyProtectionUntil(protectionMs);
  const putDeadline = (requested: string | undefined) =>
    resolveBodyProtectionUntil(requested, protectionMs);
  const schema = quoteEventIdentifier(
    validateEventSchemaName(options.schema.trim()),
  );
  const bodies = `${schema}."content_bodies"`;
  const parts = `${schema}."content_body_parts"`;
  let ready: Promise<void> | undefined;

  const ensure = () => {
    ready ??= (async () => {
      await session.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${bodies} (
          body_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('open', 'sealing', 'ready', 'aborted')),
          media_type TEXT NOT NULL,
          byte_length BIGINT NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
          digest TEXT,
          writer_generation BIGINT,
          writer_token_hash TEXT,
          lease_expires_at TIMESTAMPTZ,
          protected_until TIMESTAMPTZ,
          maintenance_version BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ready_at TIMESTAMPTZ
        )`,
      );
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${parts} (
          body_id TEXT NOT NULL REFERENCES ${bodies}(body_id) ON DELETE CASCADE,
          start_offset BIGINT NOT NULL CHECK (start_offset >= 0),
          append_id TEXT NOT NULL,
          bytes BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (body_id, start_offset),
          UNIQUE (body_id, append_id)
        )`,
      );
    })();
    return ready;
  };

  const loadBody = async (
    bodyId: string,
    executor: SqlExecutor = session,
    lock: boolean = false,
  ): Promise<BodyRow | null> => {
    await ensure();
    const result = await executor.query<BodyRow>(
      `SELECT body_id, state, media_type, byte_length, digest,
              writer_generation, writer_token_hash, lease_expires_at,
              protected_until, maintenance_version, created_at, updated_at,
              ready_at
         FROM ${bodies}
        WHERE body_id = $1
        LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [bodyId],
    );
    return result.rows[0] ?? null;
  };

  const requireBody = async (bodyId: string): Promise<BodyRow> => {
    const row = await loadBody(bodyId);
    if (!row) {
      throw createContentError(
        "asset_not_found",
        "Database body was not found.",
      );
    }
    return row;
  };

  const readParts = async (
    bodyId: string,
    executor: SqlExecutor = session,
  ): Promise<Uint8Array> => {
    await ensure();
    const result = await executor.query<PartRow>(
      `SELECT start_offset, append_id, bytes
         FROM ${parts}
        WHERE body_id = $1
        ORDER BY start_offset ASC`,
      [bodyId],
    );
    return concatBytes(result.rows.map((row) => bytesFromSql(row.bytes)));
  };

  const atomically = async <T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> => {
    const transactional = session as
      & SqlExecutor
      & Readonly<{
        transaction?: <TResult>(
          callback: (transaction: SqlExecutor) => Promise<TResult>,
        ) => Promise<TResult>;
      }>;
    return typeof transactional.transaction === "function"
      ? await transactional.transaction(operation)
      : await operation(session);
  };

  const requireOwner = (row: BodyRow, reservationId: string): void => {
    if (row.writer_token_hash !== reservationId) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this body.",
      );
    }
  };

  const progressive: ProgressiveBodyOps = {
    async reserve(input) {
      await ensure();
      const reservationId = crypto.randomUUID();
      const leaseExpiresAt = deadline();
      const inserted = await session.query<BodyRow>(
        `INSERT INTO ${bodies}
           (body_id, state, media_type, byte_length, writer_generation,
            writer_token_hash, lease_expires_at, maintenance_version, updated_at)
         VALUES ($1, 'open', $2, 0, 1, $3, $4, 1, NOW())
         ON CONFLICT (body_id) DO NOTHING
         RETURNING body_id, state, media_type, byte_length, digest,
                   writer_generation, writer_token_hash, lease_expires_at,
                   protected_until, maintenance_version, created_at, updated_at,
                   ready_at`,
        [input.bodyId, input.mediaType, reservationId, leaseExpiresAt],
      );
      if (inserted.rows[0]) {
        return writerCapabilityFromHead(mapSpill(inserted.rows[0]));
      }
      const existing = await requireBody(input.bodyId);
      if (existing.media_type !== input.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive body media type does not match the writer.",
        );
      }
      if (existing.state === "ready") {
        throw createContentError(
          "asset_conflict",
          "A ready body already exists for this id.",
        );
      }
      if (
        input.expectedGeneration === undefined ||
        input.expectedGeneration !==
          asInteger(existing.writer_generation ?? 0, "writer generation")
      ) {
        throw createContentError(
          "asset_conflict",
          "A progressive writer already owns this body.",
        );
      }
      const generation = asInteger(
        existing.writer_generation ?? 0,
        "writer generation",
      ) + 1;
      const takeoverLeaseExpiresAt = deadline();
      const claimed = await session.query<BodyRow>(
        `UPDATE ${bodies}
            SET writer_generation = $2,
                writer_token_hash = $3,
                lease_expires_at = $5,
                maintenance_version = maintenance_version + 1,
                updated_at = NOW()
          WHERE body_id = $1
            AND writer_token_hash IS NOT DISTINCT FROM $4
            AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
          RETURNING body_id, state, media_type, byte_length, digest,
                    writer_generation, writer_token_hash, lease_expires_at,
                    protected_until, maintenance_version, created_at,
                    updated_at, ready_at`,
        [
          input.bodyId,
          generation,
          reservationId,
          existing.writer_token_hash,
          takeoverLeaseExpiresAt,
        ],
      );
      if (!claimed.rows[0]) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer reservation raced with another owner.",
        );
      }
      return writerCapabilityFromHead(mapSpill(claimed.rows[0]));
    },
    async head(bodyId) {
      const row = await loadBody(bodyId);
      if (!row || row.state === "ready") return null;
      return mapSpill(row);
    },
    async append(input) {
      await ensure();
      const existing = await requireBody(input.writer.bodyId);
      requireOwner(existing, input.writer.reservationId);
      if (existing.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      if (existing.media_type !== input.writer.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive body media type does not match the writer.",
        );
      }
      if (input.bytes.byteLength === 0) {
        return Object.freeze({
          startOffset: input.expectedOffset,
          endOffset: asInteger(existing.byte_length, "byte length"),
          protection: Object.freeze({
            remainingMs: existing.lease_expires_at
              ? Math.max(0, Date.parse(existing.lease_expires_at) - Date.now())
              : 0,
          }),
        });
      }
      const start = asInteger(existing.byte_length, "byte length");
      const duplicate = await session.query<PartRow>(
        `SELECT start_offset, append_id, bytes
           FROM ${parts}
          WHERE body_id = $1 AND append_id = $2
          LIMIT 1`,
        [input.writer.bodyId, input.appendId],
      );
      if (duplicate.rows[0]) {
        const row = duplicate.rows[0];
        const bytes = bytesFromSql(row.bytes);
        const same = asInteger(row.start_offset, "append start offset") ===
            input.expectedOffset &&
          bytes.byteLength === input.bytes.byteLength &&
          bytes.every((byte, index) => byte === input.bytes[index]);
        if (!same) {
          throw createContentError(
            "asset_conflict",
            "Progressive append id was reused with different bytes.",
          );
        }
        return Object.freeze({
          startOffset: input.expectedOffset,
          endOffset: asInteger(existing.byte_length, "byte length"),
          protection: Object.freeze({
            remainingMs: existing.lease_expires_at
              ? Math.max(0, Date.parse(existing.lease_expires_at) - Date.now())
              : 0,
          }),
        });
      }
      if (input.expectedOffset !== start) {
        throw createContentError(
          "asset_conflict",
          "Progressive append expected offset does not match the body.",
        );
      }
      await session.query(
        `INSERT INTO ${parts} (body_id, start_offset, append_id, bytes)
         VALUES ($1, $2, $3, $4)`,
        [input.writer.bodyId, start, input.appendId, input.bytes],
      );
      const updated = await session.query<BodyRow>(
        `UPDATE ${bodies}
            SET byte_length = byte_length + $2,
                lease_expires_at = $4,
                maintenance_version = maintenance_version + 1,
                updated_at = NOW()
          WHERE body_id = $1
            AND writer_token_hash = $3
          RETURNING body_id, state, media_type, byte_length, digest,
                    writer_generation, writer_token_hash, lease_expires_at,
                    protected_until, maintenance_version, created_at,
                    updated_at, ready_at`,
        [
          input.writer.bodyId,
          input.bytes.byteLength,
          input.writer.reservationId,
          deadline(),
        ],
      );
      if (!updated.rows[0]) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      const head = mapSpill(updated.rows[0]);
      return Object.freeze({
        startOffset: input.expectedOffset,
        endOffset: head.byteLength,
        protection: Object.freeze({
          remainingMs: Math.max(0, head.writerLeaseRemainingMs ?? 0),
        }),
      });
    },
    async readRange(input) {
      const row = await requireBody(input.bodyId);
      if (row.state === "ready" || row.state === "aborted") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      const start = Math.max(0, input.offset);
      const end = Math.min(
        input.end,
        asInteger(row.byte_length, "byte length"),
      );
      if (end <= start) return new Uint8Array();
      return (await readParts(input.bodyId)).subarray(start, end);
    },
    async abort(input) {
      await ensure();
      const removed = await session.query<{ body_id: string }>(
        `DELETE FROM ${bodies}
          WHERE body_id = $1
            AND state <> 'ready'
            AND writer_token_hash = $2
         RETURNING body_id`,
        [input.writer.bodyId, input.writer.reservationId],
      );
      if (removed.rows[0]) return;
      const existing = await loadBody(input.writer.bodyId);
      if (existing && existing.state !== "ready") {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
    },
  };

  const store: BodyStore = {
    kind: "database",
    backendId,
    async put(input) {
      await ensure();
      const protectedUntil = putDeadline(input.protectedUntil);
      return await atomically(async (transaction) => {
        const inserted = await transaction.query<BodyRow>(
          `INSERT INTO ${bodies}
             (body_id, state, media_type, byte_length, digest, protected_until,
              maintenance_version, updated_at, ready_at)
           VALUES ($1, 'ready', $2, $3, $4, $5, 1, NOW(), NOW())
           ON CONFLICT (body_id) DO NOTHING
           RETURNING body_id, state, media_type, byte_length, digest,
                     writer_generation, writer_token_hash, lease_expires_at,
                     protected_until, maintenance_version, created_at,
                     updated_at, ready_at`,
          [
            input.bodyId,
            input.mediaType,
            input.bytes.byteLength,
            input.digest,
            protectedUntil,
          ],
        );
        if (inserted.rows[0]) {
          await transaction.query(
            `INSERT INTO ${parts} (body_id, start_offset, append_id, bytes)
             VALUES ($1, 0, 'put', $2)`,
            [input.bodyId, input.bytes],
          );
          const head = mapHead(inserted.rows[0]);
          validateHead(input, head);
          return head;
        }

        const existing = await loadBody(input.bodyId, transaction, true);
        if (!existing) {
          throw createContentError(
            "asset_storage_unavailable",
            "Database body disappeared during acquire-or-create.",
          );
        }
        if (existing.state === "ready") {
          validateHead(input, mapHead(existing));
          const renewed = await transaction.query<BodyRow>(
            `UPDATE ${bodies}
                SET protected_until = GREATEST(
                      COALESCE(protected_until, $2::timestamptz),
                      $2::timestamptz
                    ),
                    maintenance_version = maintenance_version + 1,
                    updated_at = NOW()
              WHERE body_id = $1
                AND state = 'ready'
              RETURNING body_id, state, media_type, byte_length, digest,
                        writer_generation, writer_token_hash, lease_expires_at,
                        protected_until, maintenance_version, created_at,
                        updated_at, ready_at`,
            [input.bodyId, protectedUntil],
          );
          if (!renewed.rows[0]) {
            throw createContentError(
              "asset_storage_unavailable",
              "Database body renewal lost its locked row.",
            );
          }
          return mapHead(renewed.rows[0]);
        }
        if (existing.media_type !== input.mediaType) {
          throw createContentError(
            "asset_conflict",
            "Stored body conflicts with the canonical metadata.",
          );
        }
        const bytes = await readParts(input.bodyId, transaction);
        if (
          bytes.byteLength !== input.bytes.byteLength ||
          !bytes.every((byte, index) => byte === input.bytes[index])
        ) {
          throw createContentError(
            "asset_conflict",
            "Progressive body bytes conflict with finalization input.",
          );
        }
        const finalized = await transaction.query<BodyRow>(
          `UPDATE ${bodies}
              SET state = 'ready',
                  digest = $2,
                  protected_until = $3,
                  lease_expires_at = NULL,
                  maintenance_version = maintenance_version + 1,
                  updated_at = NOW(),
                  ready_at = NOW()
            WHERE body_id = $1
              AND state <> 'ready'
            RETURNING body_id, state, media_type, byte_length, digest,
                      writer_generation, writer_token_hash, lease_expires_at,
                      protected_until, maintenance_version, created_at,
                      updated_at, ready_at`,
          [input.bodyId, input.digest, protectedUntil],
        );
        if (!finalized.rows[0]) {
          throw createContentError(
            "asset_storage_unavailable",
            "Database progressive body finalization lost its locked row.",
          );
        }
        const head = mapHead(finalized.rows[0]);
        validateHead(input, head);
        return head;
      });
    },
    async head({ bodyId }) {
      const row = await loadBody(bodyId);
      if (!row) return null;
      return row.state === "ready" ? mapHead(row) : mapSpill(row);
    },
    async read({ bodyId }) {
      const row = await requireBody(bodyId);
      if (row.state !== "ready") {
        throw createContentError(
          "asset_not_found",
          "Database body is not ready.",
        );
      }
      const bytes = await readParts(bodyId);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async follow(input) {
      const row = await requireBody(input.bodyId);
      const bytes = row.state === "ready"
        ? await readBodyBytes(store, { bodyId: input.bodyId })
        : await progressive.readRange({
          bodyId: input.bodyId,
          offset: Math.max(0, input.offset ?? 0),
          end: asInteger(row.byte_length, "byte length"),
        });
      const offset = Math.max(0, input.offset ?? 0);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            row.state === "ready" ? bytes.subarray(offset) : bytes,
          );
          controller.close();
        },
      });
    },
    reserve: progressive.reserve,
    append: progressive.append,
    async seal(input) {
      await ensure();
      const existing = await requireBody(input.writer.bodyId);
      requireOwner(existing, input.writer.reservationId);
      if (existing.state !== "open" && existing.state !== "sealing") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      const byteLength = asInteger(existing.byte_length, "byte length");
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match seal expectation.",
        );
      }
      const digest = await digestContent(await readParts(input.writer.bodyId));
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw createContentError(
          "asset_conflict",
          "Progressive body digest does not match seal expectation.",
        );
      }
      const sealed = await session.query<BodyRow>(
        `UPDATE ${bodies}
            SET state = 'ready',
                digest = $2,
                protected_until = $4,
                lease_expires_at = NULL,
                maintenance_version = maintenance_version + 1,
                updated_at = NOW(),
                ready_at = NOW()
          WHERE body_id = $1
            AND writer_token_hash = $3
            AND state IN ('open', 'sealing')
          RETURNING body_id, state, media_type, byte_length, digest,
                    writer_generation, writer_token_hash, lease_expires_at,
                    protected_until, maintenance_version, created_at,
                    updated_at, ready_at`,
        [
          input.writer.bodyId,
          digest,
          input.writer.reservationId,
          deadline(),
        ],
      );
      if (!sealed.rows[0]) {
        throw createContentError(
          "asset_conflict",
          "Progressive body seal raced with another writer.",
        );
      }
      return mapHead(sealed.rows[0]);
    },
    abort: progressive.abort,
    maintenance: {
      async list(input) {
        await ensure();
        if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
          throw new TypeError(
            "Body maintenance idle duration must be a non-negative integer.",
          );
        }
        const states = input.states.length > 0 ? [...input.states] : [];
        if (states.length === 0) {
          return Object.freeze({ bodies: Object.freeze([]) });
        }
        const after = input.after ?? "";
        const result = await session.query<BodyRow>(
          `SELECT body_id, state, media_type, byte_length, digest,
                  writer_generation, writer_token_hash, lease_expires_at,
                  protected_until, maintenance_version, created_at, updated_at,
                  ready_at
             FROM ${bodies}
            WHERE state = ANY($1)
              AND body_id > $2
              AND updated_at <= NOW() -
                    ($3::double precision * INTERVAL '1 millisecond')
            ORDER BY body_id
            LIMIT $4`,
          [states, after, input.idleForMs, input.limit],
        );
        const page = result.rows.map(mapAnyHead);
        return Object.freeze({
          bodies: Object.freeze(page),
          ...(page.length === input.limit
            ? { after: page[page.length - 1].bodyId }
            : {}),
        });
      },
      async delete(input) {
        await ensure();
        if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
          throw new TypeError(
            "Body maintenance idle duration must be a non-negative integer.",
          );
        }
        const removed = await session.query<{ body_id: string }>(
          `DELETE FROM ${bodies}
            WHERE body_id = $1
              AND state = $2
              AND maintenance_version = $3
              AND (protected_until IS NULL OR protected_until <= NOW())
              AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
              AND updated_at <= NOW() -
                    ($4::double precision * INTERVAL '1 millisecond')
           RETURNING body_id`,
          [
            input.bodyId,
            input.expectedState,
            input.expectedMaintenanceVersion,
            input.idleForMs,
          ],
        );
        return Boolean(removed.rows[0]);
      },
    },
  };
  return Object.freeze(store);
}
