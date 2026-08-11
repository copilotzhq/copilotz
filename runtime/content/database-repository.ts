import { ulid } from "../../dependencies/ulid.ts";
import type {
  EventCoordinator,
  EventMutationContext,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import { cloneContentRef } from "./input.ts";
import type {
  AssetBody,
  AssetBodyLocation,
  AssetRecord,
  AssetRepository,
  AssetState,
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedAsset,
  PreparedContent,
  PublishAssetInput,
} from "./types.ts";

const DEFAULT_MAX_DATABASE_BYTES = 64 * 1024;

type AssetNodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type AssetMutationInput = Readonly<{
  namespace: string;
  content: DurableContentInput;
}>;

export type LinkAssetOwnerInput = Readonly<{
  namespace: string;
  ownerId: string;
  content: ContentSequence;
}>;

export type DatabaseAssetRepository =
  & AssetRepository
  & Readonly<{
    /** Makes prepared bodies durable inside an aggregate's open transaction. */
    materialize(
      context: EventMutationContext,
      input: AssetMutationInput,
    ): Promise<ContentSequence>;
    /** Resolves a replay to existing bodies without writing. */
    resolvePrepared(
      context: EventMutationContext,
      input: AssetMutationInput,
    ): Promise<ContentSequence>;
    /** Adds typed owner links after the owner node exists. */
    linkOwner(
      context: EventMutationContext,
      input: LinkAssetOwnerInput,
    ): Promise<void>;
    /** Replaces an owner's liveness links after a typed record update. */
    syncOwner(
      context: EventMutationContext,
      input: LinkAssetOwnerInput,
    ): Promise<void>;
  }>;

export type CreateDatabaseAssetRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  createId?: () => string;
  now?: () => Date;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
  maxDatabaseBytes?: number;
}>;

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloneMetadata(value: unknown): Record<string, unknown> | undefined {
  const fields = record(value);
  return Object.keys(fields).length > 0 ? structuredClone(fields) : undefined;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw createContentError("content_invalid", `${name} must be non-empty.`);
  }
  return normalized;
}

function state(value: unknown, assetId: string): AssetState {
  if (
    value === "staging" || value === "ready" || value === "failed" ||
    value === "abandoned" || value === "deleted"
  ) {
    return value;
  }
  throw createContentError(
    "asset_corrupted",
    `Asset has an invalid state: ${assetId}`,
    { assetId },
  );
}

function location(value: unknown, assetId: string): AssetBodyLocation {
  const fields = record(value);
  if (
    fields.kind === "database" &&
    (fields.encoding === "utf8" || fields.encoding === "json" ||
      fields.encoding === "base64")
  ) {
    return { kind: "database", encoding: fields.encoding };
  }
  if (fields.kind === "memory") return { kind: "memory" };
  if (
    fields.kind === "object" && typeof fields.backendId === "string" &&
    typeof fields.key === "string"
  ) {
    return {
      kind: "object",
      backendId: fields.backendId,
      key: fields.key,
      ...(typeof fields.etag === "string" ? { etag: fields.etag } : {}),
    };
  }
  throw createContentError(
    "asset_corrupted",
    `Asset has an invalid body location: ${assetId}`,
    { assetId },
  );
}

function mapAsset(row: AssetNodeRow): AssetRecord {
  const data = record(row.data);
  const mediaType = typeof data.mediaType === "string" ? data.mediaType : "";
  const digest = typeof data.digest === "string" ? data.digest : "";
  const byteLength = Number(data.byteLength);
  if (
    !mediaType || !digest.startsWith("sha256:") ||
    !Number.isSafeInteger(byteLength) || byteLength < 0
  ) {
    throw createContentError(
      "asset_corrupted",
      `Asset metadata is invalid: ${row.id}`,
      { namespace: row.namespace, assetId: row.id },
    );
  }
  const mapped: AssetRecord = {
    id: row.id,
    namespace: row.namespace,
    mediaType,
    byteLength,
    digest: digest as `sha256:${string}`,
    state: state(data.state, row.id),
    location: location(data.location, row.id),
    createdAt: iso(row.created_at),
    ...(typeof data.readyAt === "string" ? { readyAt: data.readyAt } : {}),
    ...(typeof data.deletedAt === "string"
      ? { deletedAt: data.deletedAt }
      : {}),
    ...(cloneMetadata(data.metadata)
      ? { metadata: cloneMetadata(data.metadata) }
      : {}),
  };
  return Object.freeze(mapped);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw createContentError(
      "asset_corrupted",
      "A database asset contains invalid base64 data.",
      { cause },
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function jsonMediaType(mediaType: string): boolean {
  const base = mediaType.toLowerCase().split(";", 1)[0].trim();
  return base === "application/json" || base.endsWith("+json");
}

function textMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("text/");
}

function encodeDatabaseBody(
  mediaType: string,
  body: Uint8Array,
): { body: string; location: AssetBodyLocation } {
  if (jsonMediaType(mediaType) || textMediaType(mediaType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (jsonMediaType(mediaType)) JSON.parse(text);
    } catch (cause) {
      throw createContentError(
        "content_invalid",
        `Asset body is not valid ${
          jsonMediaType(mediaType) ? "JSON" : "UTF-8"
        }.`,
        { cause },
      );
    }
    return {
      body: text,
      location: {
        kind: "database",
        encoding: jsonMediaType(mediaType) ? "json" : "utf8",
      },
    };
  }
  return {
    body: encodeBase64(body),
    location: { kind: "database", encoding: "base64" },
  };
}

function decodeDatabaseBody(row: AssetNodeRow, asset: AssetRecord): Uint8Array {
  const data = record(row.data);
  if (asset.location.kind !== "database") {
    throw createContentError(
      "asset_storage_unavailable",
      `No configured body backend can read asset: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  }
  if (typeof data.body !== "string") {
    throw createContentError(
      "asset_corrupted",
      `Asset body is unavailable: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  }
  return asset.location.encoding === "base64"
    ? decodeBase64(data.body)
    : new TextEncoder().encode(data.body);
}

function isContentSequence(
  content: DurableContentInput,
): content is ContentSequence {
  return Array.isArray(content);
}

function preparedInput(content: DurableContentInput): PreparedContent {
  if (isContentSequence(content)) {
    return Object.freeze({
      content: Object.freeze(content.map(cloneContentRef)),
      assets: Object.freeze([]),
    });
  }
  if (
    !content || typeof content !== "object" ||
    !Array.isArray(content.content) || !Array.isArray(content.assets)
  ) {
    throw createContentError(
      "content_invalid",
      "Durable content must be canonical refs or a prepared content batch.",
    );
  }
  return content;
}

function assertRecordMatches(
  existing: AssetRecord,
  candidate: Pick<PreparedAsset, "mediaType" | "byteLength" | "digest">,
  key?: string,
): void {
  if (
    existing.state !== "ready" || existing.mediaType !== candidate.mediaType ||
    existing.byteLength !== candidate.byteLength ||
    existing.digest !== candidate.digest
  ) {
    throw createContentError(
      "asset_conflict",
      key
        ? `Asset idempotency key was reused with different content: ${key}`
        : `Asset ID was reused with different content: ${existing.id}`,
      { namespace: existing.namespace, assetId: existing.id },
    );
  }
}

function assertReadable(asset: AssetRecord): void {
  if (asset.state === "deleted") {
    throw createContentError(
      "asset_deleted",
      `Asset has been deleted: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  }
  if (asset.state !== "ready") {
    throw createContentError(
      "asset_not_ready",
      `Asset is not ready: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  }
}

/** Creates the graph-native database asset repository and aggregate seam. */
export function createDatabaseAssetRepository(
  options: CreateDatabaseAssetRepositoryOptions,
): DatabaseAssetRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const digest = options.digest ?? digestContent;
  const maxDatabaseBytes = options.maxDatabaseBytes ??
    DEFAULT_MAX_DATABASE_BYTES;
  if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 0) {
    throw new TypeError("maxDatabaseBytes must be a non-negative integer.");
  }
  const tables = options.eventStore.tables;

  const findById = async (
    executor: SqlExecutor,
    namespace: string,
    assetId: string,
  ): Promise<AssetNodeRow | null> => {
    const result = await executor.query<AssetNodeRow>(
      `SELECT * FROM ${tables.nodes}
       WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
      [namespace, assetId],
    );
    return result.rows[0] ?? null;
  };

  const findByIdempotency = async (
    executor: SqlExecutor,
    namespace: string,
    key: string,
  ): Promise<AssetNodeRow | null> => {
    const result = await executor.query<AssetNodeRow>(
      `SELECT * FROM ${tables.nodes}
       WHERE namespace = $1 AND type = 'asset'
         AND source_type = 'asset_idempotency' AND source_id = $2
       LIMIT 1`,
      [namespace, key],
    );
    return result.rows[0] ?? null;
  };

  const requireRow = async (
    executor: SqlExecutor,
    namespace: string,
    assetId: string,
  ): Promise<AssetNodeRow> => {
    const row = await findById(executor, namespace, assetId);
    if (!row) {
      throw createContentError(
        "asset_not_found",
        `Asset not found: ${assetId}`,
        { namespace, assetId },
      );
    }
    return row;
  };

  const validateCandidate = async (
    namespace: string,
    candidate: PreparedAsset,
  ): Promise<void> => {
    if (candidate.namespace !== namespace) {
      throw createContentError(
        "content_invalid",
        `Prepared asset belongs to another namespace: ${candidate.id}`,
        { namespace, assetId: candidate.id },
      );
    }
    if (!(candidate.body instanceof Uint8Array)) {
      throw createContentError(
        "content_invalid",
        `Prepared asset body must be bytes: ${candidate.id}`,
        { namespace, assetId: candidate.id },
      );
    }
    if (
      candidate.body.byteLength !== candidate.byteLength ||
      await digest(candidate.body) !== candidate.digest
    ) {
      throw createContentError(
        "asset_corrupted",
        `Prepared asset integrity does not match: ${candidate.id}`,
        { namespace, assetId: candidate.id },
      );
    }
    if (candidate.byteLength > maxDatabaseBytes) {
      throw createContentError(
        "asset_storage_unavailable",
        `Asset exceeds the ${maxDatabaseBytes}-byte database limit and no object backend is configured.`,
        { namespace, assetId: candidate.id },
      );
    }
  };

  const insertCandidate = async (
    context: EventMutationContext,
    namespace: string,
    candidate: PreparedAsset,
  ): Promise<AssetRecord> => {
    const key = candidate.idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = await findByIdempotency(
        context.transaction,
        namespace,
        key,
      );
      if (existing) {
        const asset = mapAsset(existing);
        assertRecordMatches(asset, candidate, key);
        return asset;
      }
    }
    const idCollision = await findById(
      context.transaction,
      namespace,
      candidate.id,
    );
    if (idCollision) {
      throw createContentError(
        "asset_conflict",
        `Asset ID already exists: ${candidate.id}`,
        { namespace, assetId: candidate.id },
      );
    }
    const encoded = encodeDatabaseBody(candidate.mediaType, candidate.body);
    const readyAt = now().toISOString();
    let data: string;
    try {
      data = JSON.stringify({
        mediaType: candidate.mediaType,
        byteLength: candidate.byteLength,
        digest: candidate.digest,
        state: "ready",
        location: encoded.location,
        body: encoded.body,
        readyAt,
        metadata: structuredClone(candidate.metadata ?? {}),
      });
    } catch (cause) {
      throw createContentError(
        "content_invalid",
        `Asset metadata is not JSON serializable: ${candidate.id}`,
        { namespace, assetId: candidate.id, cause },
      );
    }
    const result = await context.transaction.query<AssetNodeRow>(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, data, source_type, source_id
       ) VALUES ($1, $2, 'asset', $3, $4::jsonb, $5, $6)
       RETURNING *`,
      [
        candidate.id,
        namespace,
        candidate.mediaType,
        data,
        key ? "asset_idempotency" : null,
        key ?? null,
      ],
    );
    return mapAsset(result.rows[0]);
  };

  const canonicalize = async (
    context: EventMutationContext,
    input: AssetMutationInput,
    write: boolean,
  ): Promise<ContentSequence> => {
    const namespace = requiredText(input.namespace, "Asset namespace");
    const prepared = preparedInput(input.content);
    const candidates = new Map<string, PreparedAsset>();
    const referenced = new Set(prepared.content.map((ref) => ref.assetId));
    for (const candidate of prepared.assets) {
      if (candidates.has(candidate.id)) {
        throw createContentError(
          "content_invalid",
          `Prepared asset ID appears more than once: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
      if (!referenced.has(candidate.id)) {
        throw createContentError(
          "content_invalid",
          `Prepared asset is not referenced by its content: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
      await validateCandidate(namespace, candidate);
      candidates.set(candidate.id, candidate);
    }

    const resolved = new Map<string, AssetRecord>();
    const remapped = new Map<string, string>();
    for (const candidate of candidates.values()) {
      let asset: AssetRecord;
      if (write) {
        asset = await insertCandidate(context, namespace, candidate);
      } else {
        const row = candidate.idempotencyKey?.trim()
          ? await findByIdempotency(
            context.transaction,
            namespace,
            candidate.idempotencyKey.trim(),
          )
          : await findById(context.transaction, namespace, candidate.id);
        if (!row) {
          throw createContentError(
            "asset_not_found",
            `Prepared asset replay could not be resolved: ${candidate.id}`,
            { namespace, assetId: candidate.id },
          );
        }
        asset = mapAsset(row);
        assertRecordMatches(
          asset,
          candidate,
          candidate.idempotencyKey?.trim(),
        );
      }
      resolved.set(asset.id, asset);
      remapped.set(candidate.id, asset.id);
    }

    const refs: ContentRef[] = [];
    for (const source of prepared.content) {
      const ref = cloneContentRef({
        ...source,
        assetId: remapped.get(source.assetId) ?? source.assetId,
      });
      let asset = resolved.get(ref.assetId);
      if (!asset) {
        const row = await findById(
          context.transaction,
          namespace,
          ref.assetId,
        );
        if (!row) {
          throw createContentError(
            "asset_not_found",
            `Referenced asset was not found: ${ref.assetId}`,
            { namespace, assetId: ref.assetId },
          );
        }
        asset = mapAsset(row);
        resolved.set(asset.id, asset);
      }
      assertReadable(asset);
      if (asset.mediaType !== ref.mediaType) {
        throw createContentError(
          "asset_conflict",
          `Referenced asset media type does not match: ${ref.assetId}`,
          { namespace, assetId: ref.assetId },
        );
      }
      refs.push(ref);
    }
    return Object.freeze(refs);
  };

  const getRows = async (
    executor: SqlExecutor,
    namespace: string,
    assetIds: readonly string[],
  ): Promise<readonly AssetNodeRow[]> => {
    if (assetIds.length === 0) return [];
    const result = await executor.query<AssetNodeRow>(
      `SELECT * FROM ${tables.nodes}
       WHERE namespace = $1 AND type = 'asset' AND id = ANY($2::text[])`,
      [namespace, [...new Set(assetIds)]],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    return assetIds.map((assetId) => {
      const row = byId.get(assetId);
      if (!row) {
        throw createContentError(
          "asset_not_found",
          `Asset not found: ${assetId}`,
          { namespace, assetId },
        );
      }
      return row;
    });
  };

  const readRows = async (
    namespace: string,
    assetIds: readonly string[],
  ): Promise<readonly AssetBody[]> => {
    const rows = await getRows(options.session, namespace, assetIds);
    return rows.map((row) => {
      const asset = mapAsset(row);
      assertReadable(asset);
      return Object.freeze({
        asset,
        bytes: decodeDatabaseBody(row, asset),
      });
    });
  };

  const linkOwner = async (
    context: EventMutationContext,
    input: LinkAssetOwnerInput,
  ): Promise<void> => {
    const namespace = requiredText(input.namespace, "Asset namespace");
    const ownerId = requiredText(input.ownerId, "Asset owner ID");
    const assetIds = [...new Set(input.content.map((ref) => ref.assetId))];
    for (const assetId of assetIds) {
      await context.transaction.query(
        `INSERT INTO ${context.tables.edges} (
           id, namespace, source_node_id, target_node_id, type, data, weight
         ) VALUES ($1, $2, $3, $4, 'has_asset', '{}', 1)
         ON CONFLICT DO NOTHING`,
        [createId(), namespace, ownerId, assetId],
      );
    }
  };

  const repository: DatabaseAssetRepository = {
    async publish(input: PublishAssetInput) {
      const namespace = requiredText(input.namespace, "Asset namespace");
      const mediaType = requiredText(input.mediaType, "Asset mediaType");
      if (!(input.body instanceof Uint8Array)) {
        throw createContentError(
          "content_invalid",
          "Asset body must be a Uint8Array.",
          { namespace },
        );
      }
      if (input.location && input.location.kind !== "database") {
        throw createContentError(
          "asset_storage_unavailable",
          "The database repository cannot publish to the requested body backend.",
          { namespace, assetId: input.id },
        );
      }
      const key = input.idempotencyKey?.trim() || undefined;
      const body = input.body.slice();
      const candidate: PreparedAsset = Object.freeze({
        id: input.id?.trim() || createId(),
        namespace,
        mediaType,
        body,
        byteLength: body.byteLength,
        digest: await digest(body),
        ...(key ? { idempotencyKey: key } : {}),
        ...(input.metadata
          ? { metadata: structuredClone(input.metadata) }
          : {}),
      });
      await validateCandidate(namespace, candidate);

      if (key) {
        const existing = await findByIdempotency(
          options.session,
          namespace,
          key,
        );
        if (existing) {
          const asset = mapAsset(existing);
          assertRecordMatches(asset, candidate, key);
          return asset;
        }
      }
      if (await findById(options.session, namespace, candidate.id)) {
        throw createContentError(
          "asset_conflict",
          `Asset ID already exists: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }

      try {
        const result = await options.coordinator.commitMutation({
          draft: {
            type: "asset.created",
            namespace,
            subject: { type: "asset", id: candidate.id },
            payload: { assetId: candidate.id },
            ...(key ? { deduplicationId: `asset.publish:${key}` } : {}),
          },
          mutate: (context) => insertCandidate(context, namespace, candidate),
          recoverDuplicate: async (_event, context) => {
            const row = key
              ? await findByIdempotency(context.transaction, namespace, key)
              : await findById(
                context.transaction,
                namespace,
                candidate.id,
              );
            if (!row) {
              throw createContentError(
                "asset_not_found",
                `Asset could not be recovered: ${candidate.id}`,
                { namespace, assetId: candidate.id },
              );
            }
            const asset = mapAsset(row);
            assertRecordMatches(asset, candidate, key);
            return asset;
          },
        });
        return result.value!;
      } catch (error) {
        if (key) {
          const raced = await findByIdempotency(
            options.session,
            namespace,
            key,
          );
          if (raced) {
            const asset = mapAsset(raced);
            assertRecordMatches(asset, candidate, key);
            return asset;
          }
        }
        throw error;
      }
    },

    async get(namespaceInput, assetIdInput) {
      const namespace = requiredText(namespaceInput, "Asset namespace");
      const assetId = requiredText(assetIdInput, "Asset ID");
      const row = await findById(options.session, namespace, assetId);
      return row ? mapAsset(row) : null;
    },

    async getMany(namespaceInput, assetIds) {
      const namespace = requiredText(namespaceInput, "Asset namespace");
      return (await getRows(options.session, namespace, assetIds)).map(
        mapAsset,
      );
    },

    async read(namespaceInput, assetIdInput) {
      const namespace = requiredText(namespaceInput, "Asset namespace");
      const assetId = requiredText(assetIdInput, "Asset ID");
      return (await readRows(namespace, [assetId]))[0];
    },

    async readMany(namespaceInput, assetIds) {
      return await readRows(
        requiredText(namespaceInput, "Asset namespace"),
        assetIds,
      );
    },

    async open(namespace, assetId) {
      const { bytes } = await repository.read(namespace, assetId);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },

    async markDeleted(namespaceInput, assetIdInput) {
      const namespace = requiredText(namespaceInput, "Asset namespace");
      const assetId = requiredText(assetIdInput, "Asset ID");
      const current = mapAsset(
        await requireRow(options.session, namespace, assetId),
      );
      if (current.state === "deleted") return current;
      const deletedAt = now().toISOString();
      const result = await options.coordinator.commitMutation({
        draft: {
          type: "asset.deleted",
          namespace,
          subject: { type: "asset", id: assetId },
          payload: { assetId },
          deduplicationId: `asset.delete:${assetId}`,
        },
        mutate: async ({ transaction, tables: names }) => {
          const updated = await transaction.query<AssetNodeRow>(
            `UPDATE ${names.nodes}
             SET data = (COALESCE(data, '{}'::jsonb) - 'body') || $1::jsonb,
                 updated_at = NOW()
             WHERE namespace = $2 AND id = $3 AND type = 'asset'
             RETURNING *`,
            [
              JSON.stringify({ state: "deleted", deletedAt }),
              namespace,
              assetId,
            ],
          );
          if (!updated.rows[0]) {
            throw createContentError(
              "asset_not_found",
              `Asset not found: ${assetId}`,
              { namespace, assetId },
            );
          }
          return mapAsset(updated.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction }) =>
          mapAsset(await requireRow(transaction, namespace, assetId)),
      });
      return result.value!;
    },

    materialize(context, input) {
      return canonicalize(context, input, true);
    },

    resolvePrepared(context, input) {
      return canonicalize(context, input, false);
    },

    linkOwner,

    async syncOwner(context, input) {
      const namespace = requiredText(input.namespace, "Asset namespace");
      const ownerId = requiredText(input.ownerId, "Asset owner ID");
      const assetIds = [...new Set(input.content.map((ref) => ref.assetId))];
      if (assetIds.length === 0) {
        await context.transaction.query(
          `DELETE FROM ${context.tables.edges}
           WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
          [namespace, ownerId],
        );
      } else {
        await context.transaction.query(
          `DELETE FROM ${context.tables.edges}
           WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'
             AND NOT (target_node_id = ANY($3::text[]))`,
          [namespace, ownerId, assetIds],
        );
      }
      await linkOwner(context, input);
    },
  };

  return Object.freeze(repository);
}
