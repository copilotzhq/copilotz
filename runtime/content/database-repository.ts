import { ulid } from "../../dependencies/ulid.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventMutationContext,
  EventStore,
  SqlExecutor,
  SqlSession,
} from "../events/index.ts";
import {
  eventDataRef,
  readEventBody,
  writeEventBody,
} from "../events/body-store.ts";
import { digestContent } from "./digest.ts";
import { assetNodeData } from "./asset-node.ts";
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
  AssetAdoptionPlan,
  AssetBody,
  AssetBodyLocation,
  AssetEventBody,
  AssetManifestEntry,
  AssetMaterializationPlan,
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

export type AssetBodyMaintenanceResult = Readonly<{
  orphanedBodiesDeleted: number;
}>;

export type DatabaseAssetRepository =
  & AssetRepository
  & Readonly<{
    /** Makes prepared bodies durable in one short repository transaction. */
    materialize(
      input: AssetMutationInput,
    ): Promise<ContentSequence>;
    /** Retries deleted bodies and removes old uploads without graph metadata. */
    maintainBodies(
      options?: Readonly<{
        now?: Date;
        orphanAfterMs?: number;
        limit?: number;
      }>,
    ): Promise<AssetBodyMaintenanceResult>;
  }>;

type CollectionAssetAdopter = Readonly<{
  prepareMaterialization(
    input: AssetMutationInput,
  ): Promise<AssetMaterializationPlan>;
  adoptMaterialization(
    context: EventMutationContext,
    plan: AssetMaterializationPlan,
  ): Promise<void>;
}>;

const collectionAssetAdopters = new WeakMap<
  DatabaseAssetRepository,
  CollectionAssetAdopter
>();

/** @internal Collection-kernel-only adoption capability. */
export function collectionAssetAdopterFor(
  assets: DatabaseAssetRepository,
): CollectionAssetAdopter {
  const adopter = collectionAssetAdopters.get(assets);
  if (!adopter) throw new TypeError("Unknown database AssetRepository.");
  return adopter;
}

export type CreateDatabaseAssetRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlSession;
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
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createContentError(
      "asset_corrupted",
      "Asset origin must be an object.",
    );
  }
  const fields = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(fields);
  const keys = Reflect.ownKeys(fields);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 || !keys.includes("type") || !keys.includes("id") ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(fields, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    }) ||
    typeof fields.type !== "string" || !fields.type.trim() ||
    typeof fields.id !== "string" || !fields.id.trim()
  ) {
    throw createContentError(
      "asset_corrupted",
      "Asset origin must contain exactly non-empty type and id.",
    );
  }
  return Object.freeze({ type: fields.type.trim(), id: fields.id.trim() });
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

function assetManifestEntry(
  asset: AssetRecord,
  idempotencyKey?: string,
): AssetManifestEntry {
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
    location: structuredClone(asset.location),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(asset.origin ? { origin: structuredClone(asset.origin) } : {}),
    ...(asset.metadata ? { metadata: structuredClone(asset.metadata) } : {}),
    createdAt: asset.createdAt,
    ...(asset.readyAt ? { readyAt: asset.readyAt } : {}),
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
    cloneOrigin(candidate.origin);
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

  const validateMutationInput = async (
    input: AssetMutationInput,
  ): Promise<
    Readonly<{
      namespace: string;
      prepared: PreparedContent;
      candidates: ReadonlyMap<string, PreparedAsset>;
    }>
  > => {
    const namespace = requiredText(input.namespace, "Asset namespace");
    cloneOrigin(input.origin);
    const prepared = preparedInput(input.content);
    const candidates = new Map<string, PreparedAsset>();
    const referenced = new Set(prepared.content.map((ref) => ref.assetId));
    for (const source of prepared.assets) {
      const candidate = Object.freeze({
        ...source,
        ...(cloneOrigin(source.origin)
          ? { origin: cloneOrigin(source.origin) }
          : {}),
      }) as PreparedAsset;
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
    return Object.freeze({ namespace, prepared, candidates });
  };

  const resolveRefs = async (
    executor: SqlExecutor,
    namespace: string,
    prepared: PreparedContent,
    resolved: Map<string, AssetRecord>,
    remapped: ReadonlyMap<string, string>,
  ): Promise<ContentSequence> => {
    const refs: ContentRef[] = [];
    for (const source of prepared.content) {
      const ref = cloneContentRef({
        ...source,
        assetId: remapped.get(source.assetId) ?? source.assetId,
      });
      let asset = resolved.get(ref.assetId);
      if (!asset) {
        const row = await findById(executor, namespace, ref.assetId);
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

  const prepareCandidate = async (
    executor: SqlExecutor,
    namespace: string,
    source: PreparedAsset,
    fallbackOrigin?: AssetOrigin,
  ): Promise<
    Readonly<{ asset: AssetRecord; adoption?: AssetAdoptionPlan }>
  > => {
    const candidate: PreparedAsset = Object.freeze({
      ...source,
      body: source.body.slice(),
      ...(source.readyBody
        ? { readyBody: structuredClone(source.readyBody) }
        : {}),
      ...(source.location
        ? { location: structuredClone(source.location) }
        : {}),
      ...(cloneOrigin(source.origin)
        ? { origin: cloneOrigin(source.origin) }
        : {}),
      ...(source.metadata
        ? { metadata: structuredClone(source.metadata) }
        : {}),
    });
    const key = candidate.idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = await findByIdempotency(
        executor,
        namespace,
        key,
      );
      if (existing) {
        const asset = mapAsset(existing);
        assertRecordMatches(asset, candidate, key);
        return Object.freeze({ asset });
      }
    }
    const idCollision = await findById(
      executor,
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
    const origin = candidate.origin ?? cloneOrigin(fallbackOrigin) ??
      Object.freeze({ type: "namespace", id: namespace });
    try {
      JSON.stringify({
        ...(origin ? { origin } : {}),
        metadata: candidate.metadata ?? {},
      });
    } catch (cause) {
      throw createContentError(
        "content_invalid",
        `Asset metadata is not JSON serializable: ${candidate.id}`,
        { namespace, assetId: candidate.id, cause },
      );
    }
    const configuredWriter = storage.writer!;
    const bodyId = candidate.readyBody?.bodyId ?? assetBodyKey({
      prefix: storage.prefix,
      databaseSchema: options.databaseSchema,
      namespace,
      assetId: candidate.id,
      origin,
    });
    let adoptionKind: AssetAdoptionPlan["kind"] = "ready";
    let adoptionCandidate = candidate;
    let storedLocation: AssetBodyLocation;
    if (candidate.readyBody) {
      storedLocation = structuredClone(candidate.location!);
    } else if (configuredWriter.kind === "database") {
      adoptionKind = "database";
      storedLocation = { kind: "database", key: bodyId };
    } else {
      const head = await configuredWriter.put({
        bodyId,
        bytes: candidate.body,
        mediaType: candidate.mediaType,
        digest: candidate.digest,
        ifAbsent: true,
      });
      if (
        head.bodyId !== bodyId || head.state !== "ready" ||
        head.mediaType !== candidate.mediaType ||
        head.byteLength !== candidate.byteLength ||
        head.digest !== candidate.digest
      ) {
        throw createContentError(
          "asset_corrupted",
          `Prepared body integrity does not match: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
      storedLocation = configuredWriter.kind === "object"
        ? {
          kind: "object",
          backendId: configuredWriter.backendId,
          key: bodyId,
          ...(head.etag ? { etag: head.etag } : {}),
        }
        : configuredWriter.kind === "filesystem"
        ? {
          kind: "filesystem",
          backendId: configuredWriter.backendId,
          key: bodyId,
        }
        : {
          kind: "memory",
          backendId: configuredWriter.backendId,
          key: bodyId,
        };
      adoptionCandidate = Object.freeze({
        ...candidate,
        readyBody: Object.freeze(structuredClone(head)),
        location: Object.freeze(structuredClone(storedLocation)),
      });
    }
    const readyAt = now().toISOString();
    const asset: AssetRecord = Object.freeze({
      id: candidate.id,
      namespace,
      mediaType: candidate.mediaType,
      byteLength: candidate.byteLength,
      digest: candidate.digest,
      state: "ready",
      location: Object.freeze(storedLocation),
      origin: Object.freeze(structuredClone(origin)),
      createdAt: readyAt,
      readyAt,
      ...(cloneMetadata(candidate.metadata)
        ? { metadata: cloneMetadata(candidate.metadata) }
        : {}),
    });
    return Object.freeze({
      asset,
      adoption: Object.freeze({
        kind: adoptionKind,
        protectionRequired: adoptionKind === "ready" &&
          adapter.deployment.readyGarbageCollection,
        candidate: adoptionCandidate,
        asset,
      }),
    });
  };

  const adoptCandidate = async (
    context: EventMutationContext,
    plan: AssetAdoptionPlan,
  ): Promise<AssetRecord> => {
    const { asset, candidate } = plan;
    const namespace = asset.namespace;
    const key = candidate.idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = await findByIdempotency(
        context.transaction,
        namespace,
        key,
      );
      if (existing) {
        const current = mapAsset(existing);
        assertRecordMatches(current, candidate, key);
        if (current.id !== asset.id) {
          throw createContentError(
            "asset_conflict",
            `Asset materialization plan became stale: ${asset.id}`,
            { namespace, assetId: asset.id },
          );
        }
        return current;
      }
    }
    const idCollision = await findById(
      context.transaction,
      namespace,
      asset.id,
    );
    if (idCollision) {
      throw createContentError(
        "asset_conflict",
        `Asset ID already exists: ${asset.id}`,
        { namespace, assetId: asset.id },
      );
    }
    const bodyId = assetBodyId(asset);
    if (!bodyId) {
      throw createContentError(
        "asset_corrupted",
        `Asset body location is missing a body id: ${asset.id}`,
        { namespace, assetId: asset.id },
      );
    }
    await context.transaction.query(
      "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))",
      [options.databaseSchema, "body-ownership"],
    );
    if (plan.kind === "ready" && plan.protectionRequired) {
      const protectedUntil = candidate.readyBody?.protectedUntil;
      const protectionDeadline = protectedUntil
        ? Date.parse(protectedUntil)
        : Number.NaN;
      if (
        !Number.isFinite(protectionDeadline) || protectionDeadline <= Date.now()
      ) {
        throw createContentError(
          "asset_corrupted",
          `Prepared ready body protection expired before adoption: ${candidate.id}`,
          { namespace, assetId: candidate.id },
        );
      }
    }
    if (plan.kind === "database") {
      const writer = createDatabaseBodyStore({
        session: context.transaction,
        schema: options.databaseSchema,
        backendId: storage.writer!.backendId,
      });
      await writer.put({
        bodyId,
        bytes: candidate.body,
        mediaType: candidate.mediaType,
        digest: candidate.digest,
        ifAbsent: true,
      });
    }
    let data: string;
    try {
      data = JSON.stringify(assetNodeData(asset, bodyId));
    } catch (cause) {
      throw createContentError(
        "content_invalid",
        `Asset metadata is not JSON serializable: ${asset.id}`,
        { namespace, assetId: asset.id, cause },
      );
    }
    const result = await context.transaction.query<AssetNodeRow>(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, data, source_type, source_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'asset', $3, $4::jsonb, $5, $6, $7, $7)
       RETURNING *`,
      [
        asset.id,
        namespace,
        asset.mediaType,
        data,
        key ? "asset_idempotency" : null,
        key ?? null,
        asset.createdAt,
      ],
    );
    return mapAsset(result.rows[0]);
  };

  const prepareMaterializationOn = async (
    executor: SqlExecutor,
    input: AssetMutationInput,
  ): Promise<AssetMaterializationPlan> => {
    const { namespace, prepared, candidates } = await validateMutationInput(
      input,
    );

    const resolved = new Map<string, AssetRecord>();
    const remapped = new Map<string, string>();
    const keyed = new Map<string, AssetRecord>();
    const adoptions: AssetAdoptionPlan[] = [];
    const manifest: AssetManifestEntry[] = [];
    for (const candidate of candidates.values()) {
      const key = candidate.idempotencyKey?.trim() || undefined;
      const local = key ? keyed.get(key) : undefined;
      let asset: AssetRecord;
      if (local) {
        assertRecordMatches(local, candidate, key);
        asset = local;
      } else {
        const preparedCandidate = await prepareCandidate(
          executor,
          namespace,
          candidate,
          input.origin,
        );
        asset = preparedCandidate.asset;
        if (preparedCandidate.adoption) {
          adoptions.push(preparedCandidate.adoption);
          manifest.push(assetManifestEntry(asset, key));
        }
        if (key) keyed.set(key, asset);
      }
      resolved.set(asset.id, asset);
      remapped.set(candidate.id, asset.id);
    }

    const content = await resolveRefs(
      executor,
      namespace,
      prepared,
      resolved,
      remapped,
    );
    return Object.freeze({
      namespace,
      content,
      assets: Object.freeze(manifest),
      adoptions: Object.freeze(adoptions),
    });
  };

  const adoptMaterialization = async (
    context: EventMutationContext,
    plan: AssetMaterializationPlan,
  ): Promise<void> => {
    const namespace = requiredText(plan.namespace, "Asset namespace");
    for (const adoption of plan.adoptions) {
      if (adoption.asset.namespace !== namespace) {
        throw createContentError(
          "content_invalid",
          `Asset adoption belongs to another namespace: ${adoption.asset.id}`,
          { namespace, assetId: adoption.asset.id },
        );
      }
      await adoptCandidate(context, adoption);
    }
  };

  const commitAssetCreation = async (
    adoption: AssetAdoptionPlan,
    execution?: Readonly<{ transaction: SqlExecutor; dispatch: false }>,
  ): Promise<CoordinatedMutationResult<AssetRecord>> => {
    const { asset, candidate } = adoption;
    const namespace = asset.namespace;
    const key = candidate.idempotencyKey?.trim() || undefined;
    const logicalId = key ? `key:${key}` : `id:${asset.id}`;
    const eventBodyId = `asset-event-body:${namespace}:create:${logicalId}`;
    const bodyId = assetBodyId(asset);
    if (!bodyId) {
      throw createContentError(
        "asset_corrupted",
        `Asset body location is missing a body id: ${asset.id}`,
        { namespace, assetId: asset.id },
      );
    }
    const eventBody: AssetEventBody = Object.freeze({
      operation: "create",
      asset,
      bodyId,
      ...(key ? { idempotencyKey: key } : {}),
    });
    return await options.coordinator.commitMutation({
      draft: {
        type: "asset.created",
        namespace,
        subject: { type: "asset", id: asset.id },
        payload: {
          dataRef: {
            eventBodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        deduplicationId: `asset.create:${logicalId}`,
      },
      ...(execution
        ? { transaction: execution.transaction, dispatch: execution.dispatch }
        : {}),
      matchData: eventBody,
      mutate: async (context) => {
        const created = await adoptCandidate(context, adoption);
        await writeEventBody(context, {
          namespace,
          id: eventBodyId,
          json: eventBody,
        });
        return created;
      },
      recoverDuplicate: async (event, context) => {
        const body = await readEventBody<AssetEventBody>(
          context,
          event.namespace,
          eventDataRef(event.payload),
        );
        if (
          body.operation !== "create" ||
          body.asset.id !== asset.id ||
          body.idempotencyKey !== key
        ) {
          throw createContentError(
            "asset_conflict",
            "Asset creation identity was reused with different input.",
            { namespace, assetId: asset.id },
          );
        }
        assertRecordMatches(body.asset, candidate, key);
        return body.asset;
      },
    });
  };

  const commitStandaloneMaterialization = async (
    plan: AssetMaterializationPlan,
  ): Promise<void> => {
    const pending: CoordinatedMutationResult<AssetRecord>[] = [];
    await options.session.transaction(async (transaction) => {
      for (const adoption of plan.adoptions) {
        pending.push(
          await commitAssetCreation(adoption, {
            transaction,
            dispatch: false,
          }),
        );
      }
    });
    for (const result of pending) {
      await options.coordinator.flushCommitted(result);
    }
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
        type: "namespace",
        id: namespace,
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
        origin: cloneOrigin(input.origin) ?? defaultOrigin,
      });
      await validateCandidate(namespace, candidate);
      const preparedCandidate = await prepareCandidate(
        options.session,
        namespace,
        candidate,
      );
      if (!preparedCandidate.adoption) return preparedCandidate.asset;
      try {
        const result = await commitAssetCreation(
          preparedCandidate.adoption,
        );
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
      const eventBodyId = `asset-event-body:${namespace}:delete:${assetId}`;
      const result = await options.coordinator.commitMutation({
        draft: {
          type: "asset.deleted",
          namespace,
          subject: { type: "asset", id: assetId },
          payload: {
            dataRef: {
              eventBodyId,
              schemaVersion: 1,
              mediaType: "application/json",
            },
          },
          deduplicationId: `asset.delete:${assetId}`,
        },
        mutate: async ({ transaction, tables: names }) => {
          await transaction.query(
            "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))",
            [options.databaseSchema, "body-ownership"],
          );
          const locked = await transaction.query<AssetNodeRow>(
            `SELECT * FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'asset'
             LIMIT 1 FOR UPDATE`,
            [namespace, assetId],
          );
          if (!locked.rows[0]) {
            throw createContentError(
              "asset_not_found",
              `Asset not found: ${assetId}`,
              { namespace, assetId },
            );
          }
          const currentRow = locked.rows[0];
          const current = mapAsset(currentRow);
          if (current.state !== "ready") {
            throw createContentError(
              "asset_conflict",
              `Asset is not ready for deletion: ${assetId}`,
              { namespace, assetId },
            );
          }
          const owners = await transaction.query<{ id: string }>(
            `SELECT id FROM ${names.edges}
             WHERE namespace = $1 AND target_node_id = $2
               AND type = 'has_asset'
             LIMIT 1`,
            [namespace, assetId],
          );
          if (owners.rows[0]) {
            throw createContentError(
              "asset_conflict",
              `Asset is still referenced by declared Collection content: ${assetId}`,
              { namespace, assetId },
            );
          }
          const bodyId = assetBodyId(current);
          if (!bodyId) {
            throw createContentError(
              "asset_corrupted",
              `Asset body location is missing a body id: ${assetId}`,
              { namespace, assetId },
            );
          }
          const idempotencyKey = currentRow.source_type ===
                "asset_idempotency" && currentRow.source_id
            ? currentRow.source_id
            : undefined;
          const deletedAt = now().toISOString();
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
          const deleted = mapAsset(updated.rows[0]);
          const eventBody: AssetEventBody = Object.freeze({
            operation: "delete",
            asset: deleted,
            bodyId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          await writeEventBody({ transaction, tables: names }, {
            namespace,
            id: eventBodyId,
            json: eventBody,
          });
          return deleted;
        },
        recoverDuplicate: async (event, context) => {
          const body = await readEventBody<AssetEventBody>(
            context,
            event.namespace,
            eventDataRef(event.payload),
          );
          if (body.operation !== "delete" || body.asset.id !== assetId) {
            throw createContentError(
              "asset_conflict",
              "Asset delete identity was reused with a different Asset.",
              { namespace, assetId },
            );
          }
          return body.asset;
        },
      });
      return result.value!;
    },

    async maintainBodies(maintenance = {}) {
      const maintenanceNow = maintenance.now ?? new Date();
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
      let orphanedBodiesDeleted = 0;
      if (storage.writer && adapter.deployment.readyGarbageCollection) {
        const prefix = assetBodySchemaPrefix({
          prefix: storage.prefix,
          databaseSchema: options.databaseSchema,
        });
        const cutoff = maintenanceNow.getTime() - orphanAfterMs;
        const candidates = await storage.writer.maintenance.list({
          states: ["ready"],
          idleForMs: orphanAfterMs,
          limit,
        });
        for (const body of candidates.bodies) {
          if (body.state !== "ready") continue;
          if (!body.bodyId.startsWith(prefix)) continue;
          const modified = body.lastModified
            ? new Date(body.lastModified).getTime()
            : Number.NaN;
          if (!Number.isFinite(modified) || modified > cutoff) continue;
          let deleted = false;
          try {
            deleted = await options.session.transaction(async (transaction) => {
              await transaction.query(
                "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
                [options.databaseSchema, "body-ownership"],
              );
              const owner = await transaction.query<{ id: string }>(
                `SELECT id FROM ${tables.nodes}
                 WHERE type IN ('asset', 'protected_value')
                   AND data ->> 'state' = 'ready'
                   AND data ->> 'bodyId' = $1
                   AND data -> 'location' ->> 'kind' = $2
                   AND (
                     (type = 'asset' AND
                       COALESCE(data -> 'location' ->> 'backendId', '') = $3)
                     OR
                     (type = 'protected_value' AND
                       data -> 'location' ->> 'backendId' = $4)
                   )
                 LIMIT 1`,
                [
                  body.bodyId,
                  storage.writer!.kind,
                  storage.writer!.kind === "database"
                    ? ""
                    : storage.writer!.backendId,
                  storage.writer!.backendId,
                ],
              );
              if (owner.rows[0]) return false;
              const maintenanceStore = storage.writer!.kind === "database"
                ? createDatabaseBodyStore({
                  session: transaction,
                  schema: options.databaseSchema,
                  backendId: storage.writer!.backendId,
                })
                : storage.writer!;
              return await maintenanceStore.maintenance.delete({
                bodyId: body.bodyId,
                expectedState: body.state,
                expectedMaintenanceVersion: body.maintenanceVersion,
                idleForMs: orphanAfterMs,
              });
            });
          } catch {
            // One unavailable backend object cannot block the remaining page.
          }
          if (deleted) orphanedBodiesDeleted++;
        }
      }
      return Object.freeze({ orphanedBodiesDeleted });
    },

    async materialize(input) {
      let plan = await prepareMaterializationOn(options.session, input);
      const attempted = new Set<string>();
      while (plan.adoptions.length > 0) {
        const signature = JSON.stringify(plan.adoptions.map((adoption) => [
          adoption.asset.id,
          adoption.candidate.idempotencyKey?.trim() || null,
          adoption.candidate.digest,
        ]));
        if (attempted.has(signature)) {
          throw createContentError(
            "asset_conflict",
            "Asset materialization could not resolve a concurrent creation.",
            { namespace: plan.namespace },
          );
        }
        attempted.add(signature);
        try {
          await commitStandaloneMaterialization(plan);
          return plan.content;
        } catch (error) {
          const refreshed = await prepareMaterializationOn(
            options.session,
            input,
          );
          if (refreshed.adoptions.length === 0) return refreshed.content;
          const refreshedSignature = JSON.stringify(
            refreshed.adoptions.map((adoption) => [
              adoption.asset.id,
              adoption.candidate.idempotencyKey?.trim() || null,
              adoption.candidate.digest,
            ]),
          );
          if (attempted.has(refreshedSignature)) throw error;
          plan = refreshed;
        }
      }
      return plan.content;
    },
  };

  const frozenRepository = Object.freeze(repository);
  collectionAssetAdopters.set(
    frozenRepository,
    Object.freeze({
      prepareMaterialization: (input) =>
        prepareMaterializationOn(options.session, input),
      adoptMaterialization,
    }),
  );
  return frozenRepository;
}
