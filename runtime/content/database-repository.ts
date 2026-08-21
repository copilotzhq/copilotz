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
import {
  assetBodyKey,
  assetBodySchemaPrefix,
  readBodiesBounded,
  readBodyBytes,
} from "./body-store.ts";
import {
  createDatabaseBodyStore,
  createDatabaseBodyStoreAdapter,
} from "./database-body-store.ts";
import { createBodyStorageRuntime } from "./storage.ts";
import type {
  AssetBody,
  AssetBodyLocation,
  AssetManifestEntry,
  AssetOrigin,
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
import { ASSET_BODY_OWNER_KIND } from "./types.ts";
import type { BodyStorageRuntime, BodyStore } from "./body-store.ts";

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
  origin?: AssetOrigin;
}>;

export type LinkAssetOwnerInput = Readonly<{
  namespace: string;
  ownerId: string;
  content: ContentSequence;
}>;

export type AssetBodyMaintenanceResult = Readonly<{
  retriedDeletions: number;
  orphanedBodiesDeleted: number;
}>;

export type DatabaseAssetRepository =
  & AssetRepository
  & Readonly<{
    /** Makes prepared bodies durable inside an aggregate's open transaction. */
    materialize(
      context: EventMutationContext,
      input: AssetMutationInput,
    ): Promise<ContentSequence>;
    /** Makes prepared bodies durable and reports replay metadata for new Assets. */
    materializeWithManifest(
      context: EventMutationContext,
      input: AssetMutationInput,
    ): Promise<
      Readonly<{
        content: ContentSequence;
        assets: readonly AssetManifestEntry[];
      }>
    >;
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
    /** Retries deleted bodies and removes old uploads without graph metadata. */
    maintainBodies(
      options?: Readonly<{
        now?: Date;
        orphanAfterMs?: number;
        limit?: number;
      }>,
    ): Promise<AssetBodyMaintenanceResult>;
  }>;

export type CreateDatabaseAssetRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  databaseSchema: string;
  storage?: BodyStorageRuntime;
  createId?: () => string;
  now?: () => Date;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
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

function cloneOrigin(value: unknown): AssetOrigin | undefined {
  const fields = record(value);
  const scope = record(fields.scope);
  const producer = record(fields.producer);
  const validScope = scope.type === "thread" && typeof scope.id === "string"
    ? { type: "thread" as const, id: scope.id }
    : scope.type === "collection" && typeof scope.collection === "string" &&
        typeof scope.id === "string"
    ? {
      type: "collection" as const,
      collection: scope.collection,
      id: scope.id,
    }
    : scope.type === "namespace" && typeof scope.id === "string"
    ? { type: "namespace" as const, id: scope.id }
    : undefined;
  if (
    !validScope || typeof producer.type !== "string" ||
    typeof producer.id !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    scope: validScope,
    producer: { type: producer.type, id: producer.id },
    ...(typeof fields.path === "string" ? { path: fields.path } : {}),
    ...(typeof fields.inferred === "boolean"
      ? { inferred: fields.inferred }
      : {}),
  });
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
  if (fields.kind === "database" && typeof fields.key === "string") {
    return { kind: "database", key: fields.key };
  }
  if (fields.kind === "memory") {
    return {
      kind: "memory",
      ...(typeof fields.backendId === "string"
        ? { backendId: fields.backendId }
        : {}),
      ...(typeof fields.key === "string" ? { key: fields.key } : {}),
    };
  }
  if (
    fields.kind === "filesystem" && typeof fields.backendId === "string" &&
    typeof fields.key === "string"
  ) {
    return { kind: "filesystem", backendId: fields.backendId, key: fields.key };
  }
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
    ...(cloneOrigin(data.origin) ? { origin: cloneOrigin(data.origin) } : {}),
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

function assetBodyId(asset: AssetRecord): string | undefined {
  return "key" in asset.location ? asset.location.key : undefined;
}

function assetManifestEntry(asset: AssetRecord): AssetManifestEntry {
  const bodyId = assetBodyId(asset);
  if (!bodyId) {
    throw createContentError(
      "asset_corrupted",
      `Asset body location is missing a body id: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  }
  return Object.freeze({
    assetId: asset.id,
    bodyId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    digest: asset.digest,
    ...(asset.origin ? { origin: structuredClone(asset.origin) } : {}),
    ...(asset.metadata ? { metadata: structuredClone(asset.metadata) } : {}),
    createdAt: asset.createdAt,
  });
}

/** Creates the graph-native database asset repository and aggregate seam. */
export function createDatabaseAssetRepository(
  options: CreateDatabaseAssetRepositoryOptions,
): DatabaseAssetRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const digest = options.digest ?? digestContent;
  const configuredStorage = options.storage ?? createBodyStorageRuntime();
  const defaultDatabaseAdapter = configuredStorage.adapter
    ? undefined
    : createDatabaseBodyStoreAdapter({
      session: options.session,
      backendId: "database:default",
    });
  const adapter = configuredStorage.adapter ?? defaultDatabaseAdapter!;
  const scope = Object.freeze({
    namespace: "@copilotz/content",
    databaseSchema: options.databaseSchema,
  });
  const scopedWriter = adapter.forScope(scope);
  const storage: BodyStorageRuntime = Object.freeze({
    adapter,
    writer: scopedWriter,
    readers: new Map([
      ...configuredStorage.readers,
      [scopedWriter.backendId, scopedWriter],
    ]),
    prefix: configuredStorage.prefix,
    maxDatabaseBytes: configuredStorage.maxDatabaseBytes,
    readConcurrency: configuredStorage.readConcurrency,
  });
  const maxDatabaseBytes = storage.maxDatabaseBytes;
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
    if (candidate.readyBody) {
      if (!candidate.location) {
        throw createContentError(
          "content_invalid",
          `Prepared ready body requires a location: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
      if (
        candidate.readyBody.state !== "ready" ||
        candidate.readyBody.mediaType !== candidate.mediaType ||
        candidate.readyBody.byteLength !== candidate.byteLength ||
        candidate.readyBody.digest !== candidate.digest ||
        assetBodyId({
          id: candidate.id,
          namespace,
          mediaType: candidate.mediaType,
          byteLength: candidate.byteLength,
          digest: candidate.digest,
          state: "ready",
          location: candidate.location,
          createdAt: "",
        }) !== candidate.readyBody.bodyId
      ) {
        throw createContentError(
          "asset_corrupted",
          `Prepared ready body integrity does not match: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
      return;
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
    if (!storage.writer && candidate.byteLength > maxDatabaseBytes) {
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
    fallbackOrigin?: AssetOrigin,
    manifest?: AssetManifestEntry[],
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
    const origin = candidate.origin ?? fallbackOrigin;
    const storedLocation: AssetBodyLocation = candidate.readyBody
      ? candidate.location!
      : await (async () => {
        const keyForBody = assetBodyKey({
          prefix: storage.prefix,
          databaseSchema: options.databaseSchema,
          namespace,
          assetId: candidate.id,
          origin,
        });
        const configuredWriter = storage.writer!;
        const writer = configuredWriter.kind === "database"
          ? createDatabaseBodyStore({
            session: context.transaction,
            schema: options.databaseSchema,
            backendId: configuredWriter.backendId,
          })
          : configuredWriter;
        const head = await writer.put({
          bodyId: keyForBody,
          bytes: candidate.body,
          mediaType: candidate.mediaType,
          digest: candidate.digest,
          ifAbsent: true,
        });
        return writer.kind === "object"
          ? {
            kind: "object" as const,
            backendId: writer.backendId,
            key: keyForBody,
            ...(head.etag ? { etag: head.etag } : {}),
          }
          : writer.kind === "filesystem"
          ? {
            kind: "filesystem" as const,
            backendId: writer.backendId,
            key: keyForBody,
          }
          : writer.kind === "database"
          ? { kind: "database" as const, key: keyForBody }
          : {
            kind: "memory" as const,
            backendId: writer.backendId,
            key: keyForBody,
          };
      })();
    const readyAt = now().toISOString();
    let data: string;
    try {
      data = JSON.stringify({
        mediaType: candidate.mediaType,
        byteLength: candidate.byteLength,
        digest: candidate.digest,
        state: "ready",
        location: storedLocation,
        readyAt,
        ...(origin ? { origin: structuredClone(origin) } : {}),
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
    const asset = mapAsset(result.rows[0]);
    const bodyId = assetBodyId(asset);
    if (bodyId) {
      await context.transaction.query(
        `INSERT INTO ${context.tables.body_references} (
           namespace, body_id, owner_kind, owner_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [namespace, bodyId, ASSET_BODY_OWNER_KIND, asset.id],
      );
    }
    manifest?.push(assetManifestEntry(asset));
    return asset;
  };

  const canonicalize = async (
    context: EventMutationContext,
    input: AssetMutationInput,
    write: boolean,
    manifest?: AssetManifestEntry[],
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
        asset = await insertCandidate(
          context,
          namespace,
          candidate,
          input.origin,
          manifest,
        );
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

  const bodyStoreForAsset = (asset: AssetRecord): BodyStore => {
    if (asset.location.kind === "database") {
      const store = storage.writer?.kind === "database"
        ? storage.writer
        : storage.readers.get("database:default");
      if (store) return store;
      throw createContentError(
        "asset_storage_unavailable",
        `Database BodyStore is not configured for asset: ${asset.id}`,
        { namespace: asset.namespace, assetId: asset.id },
      );
    }
    const backendId = asset.location.backendId;
    const store = backendId ? storage.readers.get(backendId) : undefined;
    if (store) return store;
    throw createContentError(
      "asset_storage_unavailable",
      `Body backend '${
        backendId ?? "memory"
      }' is not configured for asset: ${asset.id}`,
      { namespace: asset.namespace, assetId: asset.id },
    );
  };

  const compareDeleteReadyBody = async (
    store: BodyStore,
    bodyId: string,
  ): Promise<boolean> => {
    const head = await store.head({ bodyId });
    if (!head) return true;
    return await store.maintenance.delete({
      bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: head.maintenanceVersion,
      idleForMs: 0,
    });
  };

  const readRows = async (
    namespace: string,
    assetIds: readonly string[],
  ): Promise<readonly AssetBody[]> => {
    const rows = await getRows(options.session, namespace, assetIds);
    const assets = rows.map((row) => {
      const asset = mapAsset(row);
      assertReadable(asset);
      return asset;
    });
    const bytes = await readBodiesBounded(
      rows.map((row, index) => ({ row, asset: assets[index] })),
      storage.readConcurrency,
      async ({ asset }) => {
        const key = assetBodyId(asset);
        if (!key) {
          throw createContentError(
            "asset_corrupted",
            `Asset body location is missing a body id: ${asset.id}`,
            { namespace: asset.namespace, assetId: asset.id },
          );
        }
        const body = await readBodyBytes(bodyStoreForAsset(asset), {
          bodyId: key,
        });
        if (
          body.byteLength !== asset.byteLength ||
          await digest(body) !== asset.digest
        ) {
          throw createContentError(
            "asset_corrupted",
            `Asset body integrity check failed: ${asset.id}`,
            { namespace: asset.namespace, assetId: asset.id },
          );
        }
        return body;
      },
    );
    return Object.freeze(assets.map((asset, index) =>
      Object.freeze({
        asset,
        bytes: bytes[index],
      })
    ));
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
      const key = input.idempotencyKey?.trim() || undefined;
      const body = input.body.slice();
      const assetId = input.id?.trim() || createId();
      const defaultOrigin: AssetOrigin = {
        scope: { type: "namespace", id: namespace },
        producer: { type: "asset", id: assetId },
      };
      const candidate: PreparedAsset = Object.freeze({
        id: assetId,
        namespace,
        mediaType,
        body,
        byteLength: body.byteLength,
        digest: await digest(body),
        ...(key ? { idempotencyKey: key } : {}),
        ...(input.metadata
          ? { metadata: structuredClone(input.metadata) }
          : {}),
        origin: structuredClone(input.origin ?? defaultOrigin),
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

    async open(namespaceInput, assetIdInput) {
      const namespace = requiredText(namespaceInput, "Asset namespace");
      const assetId = requiredText(assetIdInput, "Asset ID");
      const row = await requireRow(options.session, namespace, assetId);
      const asset = mapAsset(row);
      assertReadable(asset);
      const key = assetBodyId(asset);
      if (!key) {
        throw createContentError(
          "asset_corrupted",
          `Asset body location is missing a body id: ${asset.id}`,
          { namespace, assetId },
        );
      }
      const store = bodyStoreForAsset(asset);
      const head = await store.head({ bodyId: key });
      if (
        !head || head.state !== "ready" ||
        head.byteLength !== asset.byteLength ||
        head.digest !== asset.digest || head.mediaType !== asset.mediaType
      ) {
        throw createContentError(
          "asset_corrupted",
          `Asset body metadata integrity check failed: ${asset.id}`,
          { namespace, assetId },
        );
      }
      return await store.read({ bodyId: key });
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
          const bodyId = assetBodyId(current);
          if (bodyId) {
            await transaction.query(
              `DELETE FROM ${names.body_references}
                WHERE namespace = $1
                  AND body_id = $2
                  AND owner_kind = $3
                  AND owner_id = $4`,
              [namespace, bodyId, ASSET_BODY_OWNER_KIND, assetId],
            );
          }
          return mapAsset(updated.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction }) =>
          mapAsset(await requireRow(transaction, namespace, assetId)),
      });
      const deleted = result.value!;
      if (
        current.location.kind !== "database" && current.location.backendId &&
        current.location.key
      ) {
        const bodyStore = storage.readers.get(current.location.backendId);
        if (bodyStore) {
          try {
            const deletedBody = await compareDeleteReadyBody(
              bodyStore,
              current.location.key,
            );
            if (deletedBody) {
              await options.session.query(
                `UPDATE ${tables.nodes}
                 SET data = data || jsonb_build_object('bodyDeletedAt', $3::text),
                     updated_at = NOW()
                 WHERE namespace = $1 AND id = $2 AND type = 'asset'
                   AND data ->> 'state' = 'deleted'`,
                [namespace, assetId, deletedAt],
              );
            }
          } catch {
            // Keep the durable location for maintenance retry.
          }
        }
      }
      return deleted;
    },

    async maintainBodies(maintenance = {}) {
      const maintenanceNow = maintenance.now ?? now();
      const orphanAfterMs = maintenance.orphanAfterMs ?? 24 * 60 * 60 * 1_000;
      const limit = maintenance.limit ?? 100;
      if (!Number.isFinite(orphanAfterMs) || orphanAfterMs < 0) {
        throw new TypeError("assets orphanAfterMs must be non-negative.");
      }
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
        throw new TypeError(
          "assets maintenance limit must be between 1 and 10000.",
        );
      }
      let retriedDeletions = 0;
      let orphanedBodiesDeleted = 0;
      const pending = await options.session.query<AssetNodeRow>(
        `SELECT * FROM ${tables.nodes}
         WHERE type = 'asset' AND (data ->> 'state') = 'deleted'
           AND (data ->> 'bodyDeletedAt') IS NULL
           AND (data -> 'location' ->> 'kind') <> 'database'
         ORDER BY updated_at, id LIMIT $1`,
        [limit],
      );
      for (const row of pending.rows) {
        const asset = mapAsset(row);
        if (
          asset.location.kind === "database" ||
          !asset.location.backendId || !asset.location.key
        ) continue;
        const bodyStore = storage.readers.get(asset.location.backendId);
        if (!bodyStore) continue;
        try {
          const deleted = await compareDeleteReadyBody(
            bodyStore,
            asset.location.key,
          );
          if (!deleted) continue;
          await options.session.query(
            `UPDATE ${tables.nodes}
             SET data = data || jsonb_build_object('bodyDeletedAt', $3::text),
                 updated_at = NOW()
             WHERE namespace = $1 AND id = $2 AND type = 'asset'
               AND data ->> 'state' = 'deleted'`,
            [asset.namespace, asset.id, maintenanceNow.toISOString()],
          );
          retriedDeletions++;
        } catch {
          // Keep the durable location for a later retry.
        }
      }
      const remaining = limit - retriedDeletions;
      if (storage.writer && remaining > 0) {
        const prefix = assetBodySchemaPrefix({
          prefix: storage.prefix,
          databaseSchema: options.databaseSchema,
        });
        const cutoff = maintenanceNow.getTime() - orphanAfterMs;
        const candidates = await storage.writer.maintenance.list({
          states: ["ready"],
          idleForMs: orphanAfterMs,
          limit: remaining,
        });
        for (const body of candidates.bodies) {
          if (body.state !== "ready") continue;
          if (!body.bodyId.startsWith(prefix)) continue;
          const modified = body.lastModified
            ? new Date(body.lastModified).getTime()
            : Number.NaN;
          if (!Number.isFinite(modified) || modified > cutoff) continue;
          const owner = await options.session.query<{ body_id: string }>(
            `SELECT body_id FROM ${tables.body_references}
             WHERE body_id = $1
             LIMIT 1`,
            [body.bodyId],
          );
          if (owner.rows[0]) continue;
          const deleted = await storage.writer.maintenance.delete({
            bodyId: body.bodyId,
            expectedState: body.state,
            expectedMaintenanceVersion: body.maintenanceVersion,
            idleForMs: orphanAfterMs,
          });
          if (deleted) orphanedBodiesDeleted++;
        }
      }
      return Object.freeze({ retriedDeletions, orphanedBodiesDeleted });
    },

    materialize(context, input) {
      return canonicalize(context, input, true);
    },

    async materializeWithManifest(context, input) {
      const assets: AssetManifestEntry[] = [];
      const content = await canonicalize(context, input, true, assets);
      return Object.freeze({
        content,
        assets: Object.freeze(assets),
      });
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
