import { awaitEventPublication } from "../events/coordinator.ts";
import { invalidateOwnerAlarm } from "../engine/alarms.ts";
import {
  promoteConfiguredLogicalBody,
  promotedReadyStore,
} from "./promoted-body-store.ts";
import {
  CONTENT_PROTECTION_MS,
  CONTENT_REPLAY_RETENTION_MS,
  type ContentCatalog,
  type ContentCopy,
  createContentCatalog,
  openLogicalBody,
  readLogicalHead,
} from "./catalog.ts";
import { isPendingContentRef } from "./schema.ts";
import { createContentPreparer } from "./preparer.ts";
import {
  assertSchemaCommandTransaction,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import {
  bodyStoreTables,
  provisionBodyStoreSchema,
} from "./body-store-schema.ts";
import { BODY_APPEND_MAX_BYTES } from "./body-store-operations.ts";
import { afterSqlCommit } from "../events/session.ts";
import { ulid } from "../../dependencies/ulid.ts";
import type {
  CoordinatedMutationResult,
  DurableEvent,
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
import { createContentByteLimitError, createContentError } from "./errors.ts";
import { captureContentInput, cloneContentRef } from "./input.ts";
import {
  assetBodyKey,
  assetBodySchemaPrefix,
  readBodiesBounded,
} from "./body-store.ts";
import {
  createDatabaseBodyStoreAdapter,
  databaseBodyStoreWriter,
  isDatabaseBodyStore,
  provisionDatabaseBodyStore,
} from "./database-body-store.ts";
import { createBodyStorageRuntime } from "./storage.ts";
import type {
  AssetAdoptionPlan,
  AssetBody,
  AssetEventBody,
  AssetManifestEntry,
  AssetMaterializationPlan,
  AssetOrigin,
  AssetRecord,
  AssetRepository,
  AssetState,
  ContentInput,
  ContentRef,
  ContentSequence,
  DurableContentInput,
  GeneratedContentSequence,
  PendingContentDescriptor,
  PendingContentRef,
  PreparedAsset,
  PreparedContent,
  PublishAssetInput,
  ReadViewAccess,
} from "./types.ts";
import type {
  BodyStorageRuntime,
  BodyStore,
  MutableBodyHead,
  ReadyBodyHead,
  TerminalBodyHead,
} from "./body-store.ts";

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

/** Marks the error of an adoption that found its identity already taken. */
const adoptionTaken = Symbol("copilotz.adoptionTaken");

const takenAdoption = (): Error =>
  Object.assign(new Error("Asset adoption found its identity already taken."), {
    [adoptionTaken]: true,
  });

export type AssetMutationInput = Readonly<{
  namespace: string;
  content: DurableContentInput;
  origin?: AssetOrigin;
}>;

export type AssetBodyMaintenanceResult = Readonly<{
  orphanedBodiesDeleted: number;
}>;

export type ReadyBodyRetirementResult = Readonly<
  | { status: "deleted" }
  | { status: "owned"; ownerId: string; ownerType: "asset" | "protected_value" }
  | { status: "blocked" }
>;

export type DatabaseAssetRepository =
  & AssetRepository
  & Readonly<{
    catalog: ContentCatalog;
    storeForCopy(copy: ContentCopy): BodyStore;
    registerStore(store: BodyStore): void;
    capture(
      input: Readonly<
        {
          namespace: string;
          content: ContentInput | readonly ContentInput[] | PreparedContent;
          operationKey: string;
          producer: string;
          origin?: AssetOrigin;
        }
      >,
    ): Promise<GeneratedContentSequence>;
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
        /** @internal Defers Bodies whose operational replay catalog is live. */
        isBodyRetained?: (bodyId: string) => Promise<boolean>;
      }>,
    ): Promise<AssetBodyMaintenanceResult>;
    /** @internal CAS-deletes a Ready Body only while no graph owner exists. */
    retireUnownedReadyBody(
      input: Readonly<
        { store: BodyStore; body: TerminalBodyHead | MutableBodyHead }
      >,
    ): Promise<ReadyBodyRetirementResult>;
  }>;

/**
 * An adoption composed into another statement: it stores the new bodies, and
 * optionally the asset nodes, only while nothing already holds their identity.
 */
export type AssetAdoptionStatement = Readonly<{
  invalidatesContent: boolean;
  ctes: readonly string[];
  /** Holds while no asset, key or body already occupies the adoption. */
  gate: string;
  /** Writes applied with the inserted event, given its CTE name. */
  effects(source: string): readonly string[];
  /** A jsonb expression that `refused` reads. */
  report: string;
  /** Whether the report says the adoption found its identity taken. */
  refused(report: unknown): boolean;
}>;

type CollectionAssetAdopter = Readonly<{
  prepareInCommand: boolean;
  reconcileMaterializations(
    transaction: SqlExecutor,
    plans: readonly AssetMaterializationPlan[],
  ): Promise<ReadonlyMap<string, AssetManifestEntry>>;
  /** Whether the plans can be adopted inside another statement. */
  adoptable(plans: readonly AssetMaterializationPlan[]): boolean;
  composeAdoption(
    plans: readonly AssetMaterializationPlan[],
    param: (value: unknown) => string,
    options: Readonly<{ nodes: boolean; commandTime: string }>,
  ): AssetAdoptionStatement;

  prepareMaterialization(
    input: AssetMutationInput,
    transaction?: SqlExecutor,
  ): Promise<AssetMaterializationPlan>;
  adoptMaterialization(
    context: EventMutationContext,
    plan: AssetMaterializationPlan,
  ): Promise<void>;
  publishMaterializations(
    plans: readonly AssetMaterializationPlan[],
  ): void;
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
  /** Lets a handler read an asset's row once; see ReadViewAccess. */
  readViews?: ReadViewAccess;
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
  return ({ type: fields.type.trim(), id: fields.id.trim() } as const);
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
    bodyId: requiredText(String(data.bodyId ?? ""), "Logical body identity"),
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
  return mapped;
}

function isContentSequence(
  content: DurableContentInput,
): content is GeneratedContentSequence {
  return Array.isArray(content);
}

function preparedInput(content: DurableContentInput): PreparedContent {
  if (isContentSequence(content)) {
    return ({
      content: content.map((ref) => {
        if (isPendingContentRef(ref)) {
          throw new TypeError(
            "Pending content must be resolved by the owner catalog.",
          );
        }
        return cloneContentRef(ref);
      }),
      assets: [] as const,
    } as const);
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
  return asset.bodyId;
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
  return ({
    assetId: asset.id,
    bodyId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    digest: asset.digest,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(asset.origin ? { origin: structuredClone(asset.origin) } : {}),
    ...(asset.metadata ? { metadata: structuredClone(asset.metadata) } : {}),
    createdAt: asset.createdAt,
    ...(asset.readyAt ? { readyAt: asset.readyAt } : {}),
  } as const);
}

const PREPARED_BODY_CACHE_MAX_ENTRIES = 64;
const PREPARED_BODY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

type PreparedBodyCacheEntry = Readonly<{
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  bytes: Uint8Array;
}>;

function preparedBodyCacheKey(namespace: string, assetId: string): string {
  return `${namespace}\0${assetId}`;
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
  const scope = {
    namespace: "@copilotz/content",
    databaseSchema: options.databaseSchema,
  } as const;
  const scopedWriter = adapter.forScope(scope);

  const storage: BodyStorageRuntime = {
    adapter,
    writer: scopedWriter,
    readers: new Map([
      ...configuredStorage.readers,
      [scopedWriter.backendId, scopedWriter],
    ]),
    prefix: configuredStorage.prefix,
    maxDatabaseBytes: configuredStorage.maxDatabaseBytes,
    readConcurrency: configuredStorage.readConcurrency,
  } as const;
  const maxDatabaseBytes = storage.maxDatabaseBytes;
  const tables = options.eventStore.tables;
  const runCommand = createSchemaCommandRunner(
    options.session,
    options.databaseSchema,
  );
  const catalog = createContentCatalog(options.session, options.databaseSchema);
  let databaseBodiesProvisioned = false;
  const databasePlans = new WeakMap<PreparedAsset, {
    physical_key: string;
    backend_id: string;
    collectable: boolean;
    token: string;
    parts: { start_offset: number; bytes: string; digest: string }[];
  }>();
  const copyStores = new Map(storage.readers);
  const preparedBodies = new Map<string, PreparedBodyCacheEntry>();
  let preparedBodyBytes = 0;

  const retainPreparedBody = (
    asset: AssetRecord,
    candidate: PreparedAsset,
  ): void => {
    try {
      if (
        candidate.namespace !== asset.namespace ||
        candidate.mediaType !== asset.mediaType ||
        candidate.byteLength !== asset.byteLength ||
        candidate.digest !== asset.digest ||
        candidate.body.byteLength !== asset.byteLength ||
        candidate.body.byteLength > PREPARED_BODY_CACHE_MAX_BYTES
      ) return;
      const key = preparedBodyCacheKey(asset.namespace, asset.id);
      const existing = preparedBodies.get(key);
      if (existing) {
        preparedBodyBytes -= existing.byteLength;
        preparedBodies.delete(key);
      }
      while (
        preparedBodies.size >= PREPARED_BODY_CACHE_MAX_ENTRIES ||
        preparedBodyBytes + candidate.body.byteLength >
          PREPARED_BODY_CACHE_MAX_BYTES
      ) {
        const oldest = preparedBodies.entries().next().value;
        if (!oldest) break;
        preparedBodies.delete(oldest[0]);
        preparedBodyBytes -= oldest[1].byteLength;
      }
      preparedBodies.set(key, {
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        digest: asset.digest,
        bytes: candidate.body.slice(),
      });
      preparedBodyBytes += candidate.body.byteLength;
    } catch {
      // A post-commit cache miss must never delay durable event delivery.
    }
  };

  const cachedPreparedBody = (asset: AssetRecord): Uint8Array | undefined => {
    const key = preparedBodyCacheKey(asset.namespace, asset.id);
    const cached = preparedBodies.get(key);
    if (!cached) return undefined;
    if (
      cached.mediaType !== asset.mediaType ||
      cached.byteLength !== asset.byteLength ||
      cached.digest !== asset.digest
    ) {
      preparedBodies.delete(key);
      preparedBodyBytes -= cached.byteLength;
      return undefined;
    }
    preparedBodies.delete(key);
    preparedBodies.set(key, cached);
    return cached.bytes.slice();
  };

  const forgetPreparedBody = (namespace: string, assetId: string): void => {
    const key = preparedBodyCacheKey(namespace, assetId);
    const cached = preparedBodies.get(key);
    if (!cached) return;
    preparedBodies.delete(key);
    preparedBodyBytes -= cached.byteLength;
  };

  const publishMaterializations = (
    plans: readonly AssetMaterializationPlan[],
  ): void => {
    for (const plan of plans) {
      for (const adoption of plan.adoptions) {
        retainPreparedBody(adoption.asset, adoption.candidate);
      }
    }
  };

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
        candidate.location.key !== candidate.readyBody.bodyId
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
      const candidate = ({
        ...source,
        ...(cloneOrigin(source.origin)
          ? { origin: cloneOrigin(source.origin) }
          : {}),
      } as const) as PreparedAsset;
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
    return ({ namespace, prepared, candidates } as const);
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
    return refs;
  };

  const prepareCandidate = async (
    executor: SqlExecutor,
    namespace: string,
    source: PreparedAsset,
    fallbackOrigin?: AssetOrigin,
    deferDatabase = true,
  ): Promise<
    Readonly<{ asset: AssetRecord; adoption?: AssetAdoptionPlan }>
  > => {
    const candidate: PreparedAsset = {
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
    } as const;
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
        retainPreparedBody(asset, candidate);
        return ({ asset } as const);
      }
    }
    // A database body is written by the commit itself, so nothing happens
    // before it. The commit refuses a taken id (in its statement, or in
    // adoptCandidate on the fallback path) with this same error, and the read
    // is saved. A body written before the commit must not overwrite the
    // body of the asset that holds the id, so it is checked first.
    if (candidate.readyBody || storage.writer!.kind !== "database") {
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
    }
    const origin = candidate.origin ?? cloneOrigin(fallbackOrigin) ??
      ({ type: "namespace", id: namespace } as const);
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
    const logicalBodyId = candidate.logicalBodyId ??
      `body:${namespace}:${candidate.id}`;
    const physicalKey = candidate.readyBody?.bodyId ?? assetBodyKey({
      prefix: storage.prefix,
      databaseSchema: options.databaseSchema,
      namespace,
      assetId: candidate.id,
      origin,
    });
    const backend = candidate.location?.kind === "database"
      ? "database:default"
      : candidate.location && "backendId" in candidate.location
      ? candidate.location.backendId
      : undefined;
    const physicalStore = backend
      ? storage.readers.get(backend) ?? configuredWriter
      : configuredWriter;
    const writerIdentity = {
      bodyId: logicalBodyId,
      writerId: `capture:${namespace}:${candidate.id}`,
      generation: 1,
    };
    const current = await catalog.read(logicalBodyId, executor);
    if (
      current &&
      (current.namespace !== namespace ||
        (current.terminal &&
          (current.terminal.outcome !== "completed" ||
            current.terminal.length !== candidate.byteLength ||
            current.terminal.digest !== candidate.digest)) ||
        (!current.terminal &&
          (current.writerId !== writerIdentity.writerId ||
            current.revocation !== "active" ||
            current.copy.key !== physicalKey)))
    ) {
      throw createContentError(
        "asset_conflict",
        "Logical body identity is already occupied.",
      );
    }
    let head: ReadyBodyHead;
    if (
      deferDatabase && !current && !candidate.readyBody &&
      physicalStore.kind === "database" && isDatabaseBodyStore(physicalStore) &&
      !promotedReadyStore(physicalStore)
    ) {
      // Captured bytes are staged as SQL values. Their physical and logical
      // rows are written only by the eventual adoption statement.
      if (!databaseBodiesProvisioned) {
        if (executor === options.session) {
          await provisionDatabaseBodyStore(physicalStore);
          databaseBodiesProvisioned = true;
        } else {
          databaseBodyStoreWriter(physicalStore, executor);
          await provisionBodyStoreSchema(executor, options.databaseSchema);
          afterSqlCommit(executor, () => {
            databaseBodiesProvisioned = true;
          });
        }
      }
      const parts = [] as {
        start_offset: number;
        bytes: string;
        digest: string;
      }[];
      for (
        let offset = 0;
        offset < candidate.body.length;
        offset += BODY_APPEND_MAX_BYTES
      ) {
        const bytes = candidate.body.slice(
          offset,
          offset + BODY_APPEND_MAX_BYTES,
        );
        parts.push({
          start_offset: offset,
          bytes: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          digest: await digestContent(bytes),
        });
      }
      const staged = { ...candidate, logicalBodyId };
      databasePlans.set(staged, {
        physical_key: physicalKey,
        backend_id: physicalStore.backendId,
        collectable: physicalStore.conditionalDelete,
        token: crypto.randomUUID(),
        parts,
      });
      const readyAt = now().toISOString();
      const asset: AssetRecord = {
        id: candidate.id,
        namespace,
        mediaType: candidate.mediaType,
        byteLength: candidate.byteLength,
        digest: candidate.digest,
        state: "ready",
        bodyId: logicalBodyId,
        origin: structuredClone(origin),
        createdAt: readyAt,
        readyAt,
        ...(cloneMetadata(candidate.metadata)
          ? { metadata: cloneMetadata(candidate.metadata) }
          : {}),
      };
      return {
        asset,
        adoption: { kind: "database", candidate: staged, asset },
      };
    } else if (current?.terminal) {
      const stored = (await readLogicalHead(
        executor === options.session
          ? catalog
          : createContentCatalog(executor, options.databaseSchema),
        current.bodyId,
        (copy) =>
          executor !== options.session && copy.backendKind === "database"
            ? databaseBodyStoreWriter(storeForCopy(copy), executor)
            : storeForCopy(copy),
      ))?.head;
      if (!stored || stored.state !== "ready") {
        throw createContentError(
          "content_missing",
          "Captured content body is no longer available.",
        );
      }
      head = stored;
    } else {
      if (executor !== options.session) {
        throw new TypeError(
          "External or unfinished content must be prepared before the owner command.",
        );
      }
      if (!current) {
        await catalog.reserve({
          ...writerIdentity,
          namespace,
          copy: {
            key: physicalKey,
            backendKind: physicalStore.kind,
            backendId: physicalStore.backendId,
            collectable: physicalStore.conditionalDelete,
          },
        });
      }
      if (candidate.readyBody) {
        const stored = await physicalStore.head({ bodyId: physicalKey });
        if (!stored || stored.state !== "ready") {
          throw createContentError(
            "content_missing",
            "Prepared content copy is unavailable.",
          );
        }
        head = stored;
      } else {
        if (physicalStore.kind === "database") {
          await provisionDatabaseBodyStore(physicalStore);
        }
        head = await physicalStore.put({
          bodyId: physicalKey,
          bytes: candidate.body,
          mediaType: candidate.mediaType,
          digest: candidate.digest,
          ifAbsent: true,
        });
      }
      if (
        head.byteLength !== candidate.byteLength ||
        head.digest !== candidate.digest ||
        head.mediaType !== candidate.mediaType
      ) {
        throw createContentError(
          "asset_corrupted",
          "Prepared body integrity does not match its catalog descriptor.",
        );
      }
      if (!current?.sealIntent) {
        await catalog.checkpoint({
          ...writerIdentity,
          expectedOffset: current?.committedOffset ?? 0,
          offset: head.byteLength,
        });
      }
      await catalog.sealIntent({
        ...writerIdentity,
        length: head.byteLength,
        digest: head.digest,
      });
      await catalog.sealAccepted({ ...writerIdentity, head });
    }
    if (
      head.byteLength !== candidate.byteLength ||
      head.digest !== candidate.digest || head.mediaType !== candidate.mediaType
    ) {
      throw createContentError(
        "asset_corrupted",
        "Captured body integrity does not match its descriptor.",
      );
    }
    if (executor === options.session) {
      await promoteConfiguredLogicalBody({
        catalog,
        bodyId: logicalBodyId,
        storeFor: storeForCopy,
      });
    }
    const adoptionCandidate = {
      ...candidate,
      logicalBodyId,
      readyBody: head,
    } as const;
    const readyAt = now().toISOString();
    const asset: AssetRecord = {
      id: candidate.id,
      namespace,
      mediaType: candidate.mediaType,
      byteLength: candidate.byteLength,
      digest: candidate.digest,
      state: "ready",
      bodyId: logicalBodyId,
      origin: structuredClone(origin),
      createdAt: readyAt,
      readyAt,
      ...(cloneMetadata(candidate.metadata)
        ? { metadata: cloneMetadata(candidate.metadata) }
        : {}),
    } as const;
    return ({
      asset,
      adoption: {
        kind: "ready",
        candidate: adoptionCandidate,
        asset,
      } as const,
    } as const);
  };

  const assertMaterializationOwner = (
    transaction: SqlExecutor,
    _candidates: readonly { namespace: string; key?: string }[],
  ): Promise<void> => {
    assertSchemaCommandTransaction(transaction, options.databaseSchema);
    return Promise.resolve();
  };

  // Resolve races before Collection event matching, reference projection, or writes.
  const reconcileMaterializations = async (
    transaction: SqlExecutor,
    plans: readonly AssetMaterializationPlan[],
  ): Promise<ReadonlyMap<string, AssetManifestEntry>> => {
    const adoptions = plans.flatMap((plan) => plan.adoptions);
    await assertMaterializationOwner(
      transaction,
      adoptions.map(({ asset, candidate }) => ({
        namespace: asset.namespace,
        key: candidate.idempotencyKey?.trim(),
      })),
    );
    const replacements = new Map<string, AssetManifestEntry>();
    for (const { asset, candidate } of adoptions) {
      const key = candidate.idempotencyKey?.trim();
      if (!key) continue;
      const row = await findByIdempotency(transaction, asset.namespace, key);
      if (!row) continue;
      const current = mapAsset(row);
      assertRecordMatches(current, candidate, key);
      retainPreparedBody(current, candidate);
      replacements.set(asset.id, assetManifestEntry(current, key));
    }
    return replacements;
  };

  const adoptCandidate = async (
    context: EventMutationContext,
    plan: AssetAdoptionPlan,
  ): Promise<AssetRecord> => {
    const { asset, candidate } = plan;
    const namespace = asset.namespace;
    const key = candidate.idempotencyKey?.trim() || undefined;
    if (candidate.pendingAdoption) {
      await catalog.adoptPending(context.transaction, {
        namespace,
        pendingRef: candidate.pendingAdoption.pendingRef,
        ownerId: candidate.pendingAdoption.ownerId,
        assetId: asset.id,
      });
    }
    if (key) {
      await assertMaterializationOwner(context.transaction, [{
        namespace,
        key,
      }]);
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
    if (plan.kind === "database") {
      const params: unknown[] = [];
      const composed = composeAdoption(
        [soleAdoption(plan)],
        (value) => `$${params.push(value)}`,
        {
          nodes: false,
          commandTime:
            schemaCommandContext(context.transaction, options.databaseSchema)
              .commandTime,
        },
      );
      const result = await context.transaction.query(
        `WITH ${
          [
            ...composed.ctes,
            `adoption_accepted AS (SELECT 1 WHERE ${composed.gate})`,
            ...composed.effects("adoption_accepted"),
          ].join(",")
        }
         SELECT * FROM adoption_accepted`,
        params,
      );
      if (!result.rows.length) throw takenAdoption();
      invalidateOwnerAlarm(
        context.transaction,
        options.databaseSchema,
        "content",
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
    const logical = await createContentCatalog(
      context.transaction,
      options.databaseSchema,
    ).read(bodyId);
    if (
      !logical || logical.namespace !== namespace ||
      logical.terminal?.outcome !== "completed" ||
      logical.terminal.length !== asset.byteLength ||
      logical.terminal.digest !== asset.digest
    ) {
      throw createContentError(
        "content_missing",
        "The adopted logical body is unavailable.",
      );
    }
    const retired = await context.transaction.query(
      `SELECT 1 FROM ${tables.content_copies} WHERE copy_key=$1 AND state IN ('retiring','retired')
      UNION ALL SELECT 1 FROM ${tables.owner_body_retirements} WHERE owner='schema' AND body_id=$1 AND backend_kind=$2 AND backend_id=$3`,
      [
        logical.copy.key,
        logical.copy.backendKind,
        logical.copy.backendKind === "database" ? "" : logical.copy.backendId,
      ],
    );
    if (retired.rows.length) {
      throw createContentError(
        "asset_conflict",
        "This body has entered irreversible retirement.",
      );
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
    if (
      Array.isArray(input.content) && input.content.some(isPendingContentRef)
    ) {
      if (!input.origin) {
        throw new TypeError(
          "Pending content adoption requires a domain owner.",
        );
      }
      const refs: ContentRef[] = [];
      const assets: PreparedAsset[] = [];
      for (const source of input.content) {
        if (!isPendingContentRef(source)) {
          refs.push(cloneContentRef(source));
          continue;
        }
        const pending = await catalog.resolvePending(
          input.namespace,
          source,
          executor,
        );
        if (
          pending.ownerId && pending.ownerId !== JSON.stringify(input.origin)
        ) {
          throw createContentError(
            "asset_conflict",
            "Pending content already belongs to another domain owner.",
          );
        }
        const id = `asset:${
          (await digestContent(
            new TextEncoder().encode(
              JSON.stringify([input.namespace, source.pendingRef]),
            ),
          )).slice(7)
        }`;
        const observed = await readLogicalHead(
          executor === options.session
            ? catalog
            : createContentCatalog(executor, options.databaseSchema),
          pending.body.bodyId,
          (copy) =>
            executor !== options.session &&
              isDatabaseBodyStore(storeForCopy(copy))
              ? databaseBodyStoreWriter(storeForCopy(copy), executor)
              : storeForCopy(copy),
        );
        const head = observed?.head;
        if (observed) pending.body = observed.body;
        if (
          !head || head.state !== "ready" || head.digest !== source.digest ||
          head.byteLength !== source.byteLength ||
          head.mediaType !== source.mediaType
        ) {
          throw createContentError(
            "content_missing",
            "Pending content bytes are unavailable.",
          );
        }
        refs.push({
          ...pending.descriptor.reference,
          assetId: id,
          mediaType: source.mediaType,
        });
        if (assets.some((asset) => asset.id === id)) continue;
        assets.push({
          id,
          namespace: input.namespace,
          mediaType: source.mediaType,
          body: new Uint8Array(),
          readyBody: head,
          location: pending.body.copy.backendKind === "database"
            ? { kind: "database", key: pending.body.copy.key }
            : {
              kind: pending.body.copy.backendKind as "memory" | "object",
              key: pending.body.copy.key,
              backendId: pending.body.copy.backendId,
            },
          logicalBodyId: pending.body.bodyId,
          pendingAdoption: {
            pendingRef: source.pendingRef,
            ownerId: JSON.stringify(input.origin),
          },
          byteLength: source.byteLength,
          digest: source.digest,
          idempotencyKey: `pending:${source.pendingRef}`,
          origin: input.origin,
          metadata: pending.descriptor.asset.metadata,
        });
      }
      input = { ...input, content: { content: refs, assets } };
    }
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
    return ({
      namespace,
      content,
      assets: manifest,
      adoptions: adoptions,
    } as const);
  };

  const adoptMaterialization = async (
    context: EventMutationContext,
    plan: AssetMaterializationPlan,
  ): Promise<void> => {
    assertSchemaCommandTransaction(context.transaction, options.databaseSchema);
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

  const adoptable = (plans: readonly AssetMaterializationPlan[]): boolean =>
    plans.some((plan) => plan.adoptions.length > 0) &&
    plans.every((plan) =>
      plan.adoptions.every((adoption) => !adoption.candidate.pendingAdoption)
    );
  const composeAdoption = (
    plans: readonly AssetMaterializationPlan[],
    param: (value: unknown) => string,
    { nodes, commandTime }: Readonly<{ nodes: boolean; commandTime: string }>,
  ): AssetAdoptionStatement => {
    const hasDatabase = plans.some((plan) =>
      plan.adoptions.some((adoption) => adoption.kind === "database")
    );
    const physical = bodyStoreTables(options.databaseSchema);
    const time = hasDatabase
      ? `${param(commandTime)}::timestamptz`
      : "NULL::timestamptz";
    const rows = param(
      JSON.stringify(
        plans.flatMap((plan) =>
          plan.adoptions.map(({ asset, candidate, kind }) => ({
            database: kind === "database",
            ...databasePlans.get(candidate),
            id: asset.id,
            namespace: asset.namespace,
            key: candidate.idempotencyKey ?? null,
            media_type: asset.mediaType,
            created_at: asset.createdAt,
            data: assetNodeData(asset, asset.bodyId),
          }))
        ),
      ),
    );
    return {
      invalidatesContent: hasDatabase,
      ctes: [
        `adoption_rows AS (SELECT * FROM jsonb_to_recordset(${rows}::jsonb) AS wanted(id text,namespace text,key text,media_type text,created_at timestamptz,data jsonb,database boolean,physical_key text,backend_id text,collectable boolean,token text,parts jsonb))`,
        `adoption_refused AS (SELECT EXISTS(SELECT 1 FROM adoption_rows wanted LEFT JOIN ${tables.content_logical_bodies} body ON body.body_id=wanted.data->>'bodyId'
          LEFT JOIN ${tables.content_copies} copy ON copy.copy_key=body.current_copy
          WHERE (NOT wanted.database AND (body.body_id IS NULL OR copy.copy_key IS NULL OR body.namespace<>wanted.namespace OR body.terminal->>'outcome' IS DISTINCT FROM 'completed' OR body.terminal->>'digest' IS DISTINCT FROM wanted.data->>'digest' OR (body.terminal->>'length')::bigint IS DISTINCT FROM (wanted.data->>'byteLength')::bigint OR copy.state IN ('retiring','retired') OR EXISTS(SELECT 1 FROM ${tables.owner_body_retirements} r WHERE r.body_id=copy.copy_key)))
          ${
          hasDatabase
            ? `OR (wanted.database AND (body.body_id IS NOT NULL OR wanted.physical_key IS NULL
            OR EXISTS(SELECT 1 FROM ${tables.content_copies} WHERE copy_key=wanted.physical_key)
            OR EXISTS(SELECT 1 FROM ${tables.owner_body_retirements} WHERE body_id=wanted.physical_key)
            OR EXISTS(SELECT 1 FROM ${physical.bodies} WHERE body_id=wanted.physical_key)))`
            : ""
        }
          OR EXISTS(SELECT 1 FROM ${tables.nodes} taken WHERE taken.namespace=wanted.namespace AND taken.type='asset' AND (taken.id=wanted.id OR (wanted.key IS NOT NULL AND taken.source_type='asset_idempotency' AND taken.source_id=wanted.key)))) AS refused)`,
      ],
      gate: "NOT (SELECT refused FROM adoption_refused)",
      effects: (source) => [
        ...(hasDatabase
          ? [
            `adoption_logical AS (INSERT INTO ${tables.content_logical_bodies}
            (body_id,namespace,current_copy,writer_id,generation,protected_until,committed_offset,seal_intent,terminal)
            SELECT wanted.data->>'bodyId',wanted.namespace,wanted.physical_key,'capture:'||wanted.namespace||':'||wanted.id,1,
              ${time}+(${CONTENT_PROTECTION_MS}*interval '1 millisecond'),(wanted.data->>'byteLength')::bigint,
              jsonb_build_object('length',(wanted.data->>'byteLength')::bigint,'digest',wanted.data->>'digest'),
              jsonb_build_object('length',(wanted.data->>'byteLength')::bigint,'digest',wanted.data->>'digest','outcome','completed')
            FROM adoption_rows wanted,${source} WHERE wanted.database RETURNING body_id)`,
            `adoption_physical AS (INSERT INTO ${physical.bodies}
            (body_id,state,media_type,reservation_id,writer_generation,byte_length,digest,version_token,maintenance_version,updated_at)
            SELECT wanted.physical_key,'ready',wanted.media_type,'put:'||wanted.token,1,
              (wanted.data->>'byteLength')::bigint,wanted.data->>'digest',wanted.token,1,${time}
            FROM adoption_rows wanted JOIN adoption_logical ON adoption_logical.body_id=wanted.data->>'bodyId' RETURNING body_id)`,
            `adoption_copies AS (INSERT INTO ${tables.content_copies}
            (copy_key,backend_kind,backend_id,body_id,version_token,state,collectable,retire_after)
            SELECT wanted.physical_key,'database',wanted.backend_id,wanted.data->>'bodyId',wanted.token,'current',wanted.collectable,
              ${time}+(${CONTENT_REPLAY_RETENTION_MS}*interval '1 millisecond')
            FROM adoption_rows wanted JOIN adoption_physical ON adoption_physical.body_id=wanted.physical_key)`,
            `adoption_parts AS (INSERT INTO ${physical.parts}(body_id,start_offset,append_id,bytes,part_digest)
            SELECT wanted.physical_key,part.start_offset,'put:'||part.start_offset,decode(part.bytes,'hex'),part.digest
            FROM adoption_rows wanted JOIN adoption_physical ON adoption_physical.body_id=wanted.physical_key,
              LATERAL jsonb_to_recordset(wanted.parts) AS part(start_offset bigint,bytes text,digest text))`,
          ]
          : []),
        ...(nodes
          ? [
            `adoption_nodes AS (INSERT INTO ${tables.nodes}(id,namespace,type,name,data,source_type,source_id,created_at,updated_at)
            SELECT wanted.id,wanted.namespace,'asset',wanted.media_type,wanted.data,CASE WHEN wanted.key IS NULL THEN NULL ELSE 'asset_idempotency' END,wanted.key,wanted.created_at,wanted.created_at FROM adoption_rows wanted,${source})`,
          ]
          : []),
      ],
      report:
        "jsonb_build_object('refused',(SELECT refused FROM adoption_refused))",
      refused: (report) =>
        (typeof report === "string" ? JSON.parse(report) : report)?.refused ===
          true,
    };
  };

  const soleAdoption = (
    adoption: AssetAdoptionPlan,
  ): AssetMaterializationPlan => ({
    namespace: adoption.asset.namespace,
    content: [],
    assets: [],
    adoptions: [adoption],
  } as const);

  const assetCreationEvent = (adoption: AssetAdoptionPlan) => {
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
    const eventBody: AssetEventBody = {
      operation: "create",
      asset,
      bodyId,
      ...(key ? { idempotencyKey: key } : {}),
    } as const;
    return ({
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
      matchData: eventBody,
      body: { id: eventBodyId, json: eventBody },
      recoverDuplicate: async (
        event: DurableEvent,
        context: EventMutationContext,
      ) => {
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
    } as const);
  };

  const commitAssetCreation = async (
    adoption: AssetAdoptionPlan,
    execution?: Readonly<{ transaction: SqlExecutor; dispatch: false }>,
  ): Promise<CoordinatedMutationResult<AssetRecord>> => {
    const event = assetCreationEvent(adoption);
    if (!execution) {
      // The event and asset share the mutation transaction. If the asset's
      // identity is already held, reconcile it before attempting adoption.
      if (adoptable([soleAdoption(adoption)])) {
        try {
          const result = await options.coordinator.commitMutation({
            ...event,
            dispatch: false,
            statement: (param, _tables, { commandTime }) => {
              const composed = composeAdoption(
                [soleAdoption(adoption)],
                param,
                { nodes: true, commandTime },
              );
              return {
                ...composed,
                resolve: (report: unknown, inserted: boolean) => {
                  if (inserted) return adoption.asset;
                  if (composed.refused(report)) throw takenAdoption();
                  throw new Error(
                    `Asset '${adoption.asset.id}' was not created.`,
                  );
                },
              };
            },
          });
          retainPreparedBody(result.value!, adoption.candidate);
          await awaitEventPublication(result);
          return result;
        } catch (error) {
          if (!(error as { [adoptionTaken]?: true })[adoptionTaken]) {
            throw error;
          }
        }
      }
      const result = await runCommand(
        "content.adopt",
        { namespace: adoption.asset.namespace, assetId: adoption.asset.id },
        async (_input, { transaction }) => {
          await assertMaterializationOwner(transaction, [{
            namespace: adoption.asset.namespace,
            key: adoption.candidate.idempotencyKey?.trim(),
          }]);
          return await commitAssetCreation(adoption, {
            transaction,
            dispatch: false,
          });
        },
      );
      retainPreparedBody(result.value!, adoption.candidate);
      await awaitEventPublication(result);
      return result;
    }
    return await options.coordinator.commitMutation({
      ...event,
      transaction: execution.transaction,
      dispatch: execution.dispatch,
      mutate: (context) => adoptCandidate(context, adoption),
    });
  };

  const commitStandaloneMaterialization = async (
    plan: AssetMaterializationPlan,
  ): Promise<void> => {
    if (plan.adoptions.length === 1) {
      await commitAssetCreation(plan.adoptions[0]);
      return;
    }
    const pending: CoordinatedMutationResult<AssetRecord>[] = [];
    await runCommand("content.materialize", {
      assetIds: plan.adoptions.map(({ asset }) => asset.id),
    }, async (_input, { transaction }) => {
      await assertMaterializationOwner(
        transaction,
        plan.adoptions.map(({ asset, candidate }) => ({
          namespace: asset.namespace,
          key: candidate.idempotencyKey?.trim(),
        })),
      );
      for (const adoption of plan.adoptions) {
        pending.push(
          await commitAssetCreation(adoption, {
            transaction,
            dispatch: false,
          }),
        );
      }
    });
    publishMaterializations([plan]);
    for (const result of pending) {
      await awaitEventPublication(result);
    }
  };

  const assetViewKey = (namespace: string, assetId: string) =>
    [tables.nodes, namespace, "asset", assetId].join("\u0000");

  const getRows = async (
    executor: SqlExecutor,
    namespace: string,
    assetIds: readonly string[],
  ): Promise<readonly AssetNodeRow[]> => {
    if (assetIds.length === 0) return [];
    const unique = [...new Set(assetIds)];
    // A handler reads a ready asset's row once: the row changes only when the
    // asset is deleted, and this repository forgets it then.
    const memo = executor === options.session
      ? options.readViews?.memo()
      : undefined;
    const byId = new Map<string, AssetNodeRow>();
    if (memo) {
      for (const id of unique) {
        const hit = memo.recall<AssetNodeRow>(assetViewKey(namespace, id));
        if (hit) byId.set(id, hit.value);
      }
    }
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length) {
      const ticket = memo?.begin(
        missing.map((id) => assetViewKey(namespace, id)),
      );
      const result = await executor.query<AssetNodeRow>(
        `SELECT * FROM ${tables.nodes}
       WHERE namespace = $1 AND type = 'asset' AND id = ANY($2::text[])`,
        [namespace, missing],
      );
      for (const row of result.rows) {
        byId.set(row.id, row);
        if (ticket && mapAsset(row).state === "ready") {
          ticket.remember(assetViewKey(namespace, row.id), row);
        }
      }
    }
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

  const storeForCopy = (copy: ContentCopy): BodyStore => {
    const ready = promotedReadyStore(storage.writer!);
    if (ready?.backendId === copy.backendId) return ready;
    const store = copyStores.get(copy.backendId) ??
      (copy.backendKind === "database"
        ? storage.readers.get("database:default")
        : undefined);
    if (store) return store;
    throw createContentError(
      "asset_storage_unavailable",
      `Body backend '${copy.backendId}' is not configured.`,
    );
  };
  const logicalBytes = async (asset: AssetRecord): Promise<Uint8Array> => {
    const stream = await openLogicalBody(
      catalog,
      asset.bodyId,
      storeForCopy,
      asset.byteLength,
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  const readRows = async (
    namespace: string,
    assetIds: readonly string[],
    maxBytes?: number,
  ): Promise<readonly AssetBody[]> => {
    const rows = await getRows(options.session, namespace, assetIds);
    if (maxBytes !== undefined) {
      // The rows already carry every byte length: refuse before any body read.
      const bytes = [...new Map(rows.map((row) => [row.id, row])).values()]
        .reduce((sum, row) => sum + mapAsset(row).byteLength, 0);
      if (bytes > maxBytes) throw createContentByteLimitError(bytes, maxBytes);
    }
    const assets = rows.map((row) => {
      const asset = mapAsset(row);
      assertReadable(asset);
      return asset;
    });
    const bytes = await readBodiesBounded(
      rows.map((row, index) => ({ row, asset: assets[index] })),
      storage.readConcurrency,
      async ({ asset }) => {
        const head =
          (await readLogicalHead(catalog, asset.bodyId, storeForCopy))?.head;
        if (!head || head.state !== "ready") {
          throw createContentError(
            "content_missing",
            "Captured content bytes are missing.",
          );
        }
        if (
          head.byteLength !== asset.byteLength || head.digest !== asset.digest
        ) {
          throw createContentError(
            "asset_corrupted",
            "Captured content integrity differs from its catalog descriptor.",
          );
        }
        const prepared = cachedPreparedBody(asset);
        if (prepared) return prepared;
        const key = assetBodyId(asset);
        if (!key) {
          throw createContentError(
            "asset_corrupted",
            `Asset body location is missing a body id: ${asset.id}`,
            { namespace: asset.namespace, assetId: asset.id },
          );
        }
        const body = await logicalBytes(asset);
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
    return (assets.map((asset, index) => ({
      asset,
      bytes: bytes[index],
    } as const)));
  };

  // Rotate bounded Ready-body scans across maintenance calls. Otherwise a
  // stable first page of graph-owned Bodies can starve later orphans forever.
  let bodyMaintenanceAfter: string | undefined;
  let catalogMaintenanceAfter: string | undefined;
  // Retirement is irreversible. Physical deletion can finish after takeover,
  // because every adopter checks the durable claim before taking ownership.
  const retireBody = async (
    input: Readonly<
      { store: BodyStore; body: TerminalBodyHead | MutableBodyHead }
    >,
    idleForMs: number,
  ): Promise<ReadyBodyRetirementResult> => {
    if (!input.store.conditionalDelete) return { status: "blocked" };
    const backendId = input.store.kind === "database"
      ? ""
      : input.store.backendId;
    const request = {
      backendKind: input.store.kind,
      backendId,
      bodyId: input.body.bodyId,
    };
    const claim = await runCommand(
      "content.retireClaim",
      request,
      async (request, { transaction, commandTime }) => {
        invalidateOwnerAlarm(transaction, options.databaseSchema, "content");
        if (
          "lastModified" in input.body && input.body.lastModified &&
          Date.parse(input.body.lastModified) >
            Date.parse(commandTime) - idleForMs
        ) return { status: "blocked" as const };
        const copy =
          (await transaction.query<{ body_id: string; state: string }>(
            `SELECT body_id,state FROM ${tables.content_copies} WHERE copy_key=$1 AND backend_kind=$2 AND backend_id=$3`,
            [request.bodyId, request.backendKind, input.store.backendId],
          )).rows[0];
        if (copy && copy.state !== "retiring" && copy.state !== "retired") {
          const body = await catalog.read(copy.body_id, transaction);
          if (!body) return { status: "blocked" as const };
          if (
            body.promotionTarget?.key === request.bodyId &&
            Date.parse(body.promotionTarget.expiresAt) > Date.parse(commandTime)
          ) return { status: "blocked" as const };
          if (body.copy.key === request.bodyId) {
            if (
              !body.terminal ||
              Date.parse(body.protectedUntil) > Date.parse(commandTime)
            ) return { status: "blocked" as const };
            const owned = (await transaction.query<
              { id: string; type: "asset" | "protected_value" }
            >(
              `SELECT id,type FROM ${tables.nodes} WHERE type IN ('asset','protected_value') AND data->>'state'='ready' AND data->>'bodyId'=$1 LIMIT 1`,
              [body.bodyId],
            )).rows[0];
            if (owned) {
              return {
                status: "owned" as const,
                ownerId: owned.id,
                ownerType: owned.type,
              };
            }
            const pending = (await transaction.query(
              `SELECT 1 FROM ${tables.pending_content} p WHERE body_id=$1 AND expires_at>$2::timestamptz LIMIT 1`,
              [body.bodyId, commandTime],
            )).rows.length > 0;
            if (pending) return { status: "blocked" as const };
            const streams =
              `"${options.databaseSchema}"."copilotz_operation_streams"`;
            const present = (await transaction.query<{ present: boolean }>(
              "SELECT to_regclass($1) IS NOT NULL AS present",
              [streams],
            )).rows[0]?.present;
            if (
              present &&
              (await transaction.query(
                `SELECT 1 FROM ${streams} WHERE body_id=$1 AND availability='retained' AND cleanup_state IS NULL LIMIT 1`,
                [body.bodyId],
              )).rows.length
            ) return { status: "blocked" as const };
            const operations =
              `"${options.databaseSchema}"."copilotz_operations"`;
            if (
              present &&
              (await transaction.query(
                `SELECT 1 FROM ${tables.pending_content} p JOIN ${operations} o ON o.operation_id=p.producer AND o.namespace=p.namespace WHERE p.body_id=$1 AND o.state IN ('accepted','running') LIMIT 1`,
                [body.bodyId],
              )).rows.length
            ) return { status: "blocked" as const };
          }
          await transaction.query(
            `UPDATE ${tables.content_copies} SET state='retiring',version_token=$2 WHERE copy_key=$1`,
            [request.bodyId, input.body.versionToken],
          );
        }
        await transaction.query(
          `INSERT INTO ${tables.owner_body_retirements} (owner,backend_kind,backend_id,body_id,token)
         VALUES ('schema',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [
            request.backendKind,
            request.backendId,
            request.bodyId,
            input.body.versionToken,
          ],
        );
        const row =
          (await transaction.query<{ token: string; completed: boolean }>(
            `SELECT token,completed FROM ${tables.owner_body_retirements} WHERE owner='schema' AND backend_kind=$1 AND backend_id=$2 AND body_id=$3`,
            [request.backendKind, request.backendId, request.bodyId],
          )).rows[0];
        return {
          status: "claimed" as const,
          token: row.token,
          completed: row.completed,
        };
      },
    );
    if (claim.status !== "claimed") return claim;
    // External adapters never run while the owner holds its SQL fence.
    const deleted = await input.store.maintenance.delete({
      bodyId: input.body.bodyId,
      expectedState: input.body.state,
      expectedVersionToken: claim.token,
      idleForMs,
    });
    if (!deleted && await input.store.head({ bodyId: input.body.bodyId })) {
      return { status: "blocked" };
    }
    await runCommand("content.confirmRetirement", {
      ...request,
      token: claim.token,
    }, async (request, { transaction }) => {
      invalidateOwnerAlarm(transaction, options.databaseSchema, "content");
      await transaction.query(
        `UPDATE ${tables.owner_body_retirements} SET completed=TRUE WHERE owner='schema' AND backend_kind=$1 AND backend_id=$2 AND body_id=$3 AND token=$4`,
        [request.backendKind, request.backendId, request.bodyId, request.token],
      );
      await transaction.query(
        `UPDATE ${tables.content_copies} SET state='retired' WHERE copy_key=$1 AND state='retiring'`,
        [request.bodyId],
      );
    });
    return { status: "deleted" };
  };

  const repository: DatabaseAssetRepository = {
    catalog,
    storeForCopy,
    registerStore(store) {
      copyStores.set(store.backendId, store);
      const ready = promotedReadyStore(store);
      if (ready) copyStores.set(ready.backendId, ready);
    },
    async capture(input) {
      input = captureContentInput(input);
      const prepared = (input.content && typeof input.content === "object" &&
          "content" in input.content && "assets" in input.content)
        ? input.content as PreparedContent
        : await createContentPreparer().prepare(
          input.content as ContentInput | readonly ContentInput[],
          {
            namespace: input.namespace,
            idempotencyKey: input.operationKey,
            origin: input.origin,
          },
        );
      const generated: Array<ContentRef | PendingContentRef> = [];
      for (let index = 0; index < prepared.content.length; index++) {
        const ref = prepared.content[index],
          source = prepared.assets.find((asset) => asset.id === ref.assetId);
        if (!source) {
          generated.push(ref);
          continue;
        }
        const pendingRef = `capture:${input.operationKey}:${index}`;
        const id = `capture:${
          (await digestContent(
            new TextEncoder().encode(
              JSON.stringify([input.namespace, pendingRef]),
            ),
          )).slice(7)
        }`;
        const candidate = { ...source, id, idempotencyKey: undefined };
        const preparedCandidate = await prepareCandidate(
          options.session,
          input.namespace,
          candidate,
          input.origin,
          false,
        );
        const body = await catalog.read(preparedCandidate.asset.bodyId);
        if (!body?.terminal) {
          throw createContentError(
            "content_missing",
            "Captured body was not accepted.",
          );
        }
        const head = (await readLogicalHead(catalog, body.bodyId, storeForCopy))
          ?.head;
        if (!head || head.state !== "ready") {
          throw createContentError(
            "content_missing",
            "Captured body is unavailable.",
          );
        }
        const { assetId: _assetId, mediaType: _mediaType, ...reference } = ref;
        const descriptor: PendingContentDescriptor = {
          reference,
          asset: {
            ...(input.origin ? { origin: input.origin } : {}),
            metadata: source.metadata ?? {},
          },
        };
        await catalog.sealAccepted({
          ...body,
          head,
          pending: {
            ref: pendingRef,
            producer: input.producer,
            descriptor,
            expiresAt: new Date(Date.now() + CONTENT_REPLAY_RETENTION_MS)
              .toISOString(),
          },
        });
        generated.push({
          type: "content.pending",
          pendingRef,
          mediaType: source.mediaType,
          byteLength: source.byteLength,
          digest: source.digest,
        });
      }
      return generated;
    },
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
      const candidate: PreparedAsset = {
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
      } as const;
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
            retainPreparedBody(asset, candidate);
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

    async readMany(namespaceInput, assetIds, readOptions) {
      return await readRows(
        requiredText(namespaceInput, "Asset namespace"),
        assetIds,
        readOptions?.maxBytes,
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
      return await openLogicalBody(
        catalog,
        asset.bodyId,
        storeForCopy,
        asset.byteLength,
      );
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
          assertSchemaCommandTransaction(transaction, options.databaseSchema);
          const selected = await transaction.query<AssetNodeRow>(
            `SELECT * FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'asset'
             LIMIT 1`,
            [namespace, assetId],
          );
          if (!selected.rows[0]) {
            throw createContentError(
              "asset_not_found",
              `Asset not found: ${assetId}`,
              { namespace, assetId },
            );
          }
          const currentRow = selected.rows[0];
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
              `Asset is still referenced by durable content: ${assetId}`,
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
          const eventBody: AssetEventBody = {
            operation: "delete",
            asset: deleted,
            bodyId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          } as const;
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
      const deleted = result.value!;
      forgetPreparedBody(namespace, assetId);
      return deleted;
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
      await catalog.expireReservations();
      const attemptedCopies = new Set<string>();
      const tracked = await options.session.query<
        {
          copy_key: string;
          backend_kind: string;
          backend_id: string;
          state: string;
          body_id: string;
        }
      >(
        `SELECT copy_key,backend_kind,backend_id,state,body_id FROM ${tables.content_copies} WHERE ($1::text IS NULL OR copy_key>$1) ORDER BY copy_key LIMIT $2`,
        [
          catalogMaintenanceAfter ?? null,
          Math.min(10000, Math.max(limit * 4, 100)),
        ],
      );
      for (const copy of tracked.rows) {
        catalogMaintenanceAfter = copy.copy_key;
        if (
          copy.state === "current" && maintenance.isBodyRetained &&
          await maintenance.isBodyRetained(copy.body_id)
        ) continue;
        attemptedCopies.add(copy.copy_key);
        try {
          const store = storeForCopy({
            key: copy.copy_key,
            backendKind: copy.backend_kind,
            backendId: copy.backend_id,
          });
          if (!store.conditionalDelete) continue;
          const head = await store.head({ bodyId: copy.copy_key });
          if (head) {
            const result = await retireBody(
              { store, body: head },
              orphanAfterMs,
            );
            if (result.status === "deleted") orphanedBodiesDeleted++;
            else if (result.status === "blocked") {
              await catalog.deferRetirement(copy.copy_key);
            }
          } else if (!head) {
            await runCommand("content.confirmAbsentRetirement", {
              copyKey: copy.copy_key,
            }, async (input, { transaction }) => {
              invalidateOwnerAlarm(
                transaction,
                options.databaseSchema,
                "content",
              );
              const claimed = await transaction.query(
                `UPDATE ${tables.owner_body_retirements} SET completed=TRUE WHERE owner='schema' AND body_id=$1 AND backend_kind=$2 AND backend_id=$3 RETURNING body_id`,
                [
                  input.copyKey,
                  store.kind,
                  store.kind === "database" ? "" : store.backendId,
                ],
              );
              if (claimed.rows.length) {
                await transaction.query(
                  `UPDATE ${tables.content_copies} SET state='retired' WHERE copy_key=$1`,
                  [input.copyKey],
                );
              }
            });
          }
        } catch {
          await catalog.deferRetirement(
            copy.copy_key,
          ); /* The durable retry deadline does not slide on unrelated commands. */
        }
        if (orphanedBodiesDeleted >= limit) break;
      }
      if (tracked.rows.length < Math.min(10000, Math.max(limit * 4, 100))) {
        catalogMaintenanceAfter = undefined;
      }
      if (storage.writer && orphanedBodiesDeleted < limit) {
        const prefix = assetBodySchemaPrefix({
          prefix: storage.prefix,
          databaseSchema: options.databaseSchema,
        });
        const operationStreamsPrefix = `${prefix}/content-streams/`;
        const cutoff = maintenanceNow.getTime() - orphanAfterMs;
        const maxScanned = Math.min(10_000, Math.max(1_000, limit * 4));
        const pageSize = Math.min(500, maxScanned);
        const startedAfter = bodyMaintenanceAfter !== undefined;
        let wrapped = false;
        let scanned = 0;
        while (scanned < maxScanned && orphanedBodiesDeleted < limit) {
          const candidates = await storage.writer.maintenance.list({
            states: [
              ...(adapter.deployment.readyGarbageCollection
                ? ["ready" as const]
                : []),
              "incomplete" as const,
            ],
            idleForMs: orphanAfterMs,
            prefix,
            ...(bodyMaintenanceAfter ? { after: bodyMaintenanceAfter } : {}),
            limit: Math.min(pageSize, maxScanned - scanned),
          });
          if (candidates.bodies.length === 0) {
            if (startedAfter && !wrapped) {
              bodyMaintenanceAfter = undefined;
              wrapped = true;
              continue;
            }
            bodyMaintenanceAfter = undefined;
            break;
          }
          for (const body of candidates.bodies) {
            scanned += 1;
            bodyMaintenanceAfter = body.bodyId;
            if (
              !body.bodyId.startsWith(prefix) ||
              attemptedCopies.has(body.bodyId)
            ) continue;
            attemptedCopies.add(body.bodyId);
            if (body.state !== "ready" && body.state !== "incomplete") {
              continue;
            }
            const modified = body.lastModified
              ? new Date(body.lastModified).getTime()
              : Number.NaN;
            if (!Number.isFinite(modified) || modified > cutoff) continue;
            // Operation replay Bodies have catalog-owned retention until that
            // row is pruned. Afterwards graph ownership and ordinary orphan GC
            // protect/collect an adopted canonical Body normally.
            if (
              body.bodyId.startsWith(operationStreamsPrefix) &&
              maintenance.isBodyRetained &&
              await maintenance.isBodyRetained(body.bodyId)
            ) continue;
            try {
              const result = await retireBody(
                { store: storage.writer!, body },
                orphanAfterMs,
              );
              if (result.status === "deleted") orphanedBodiesDeleted++;
            } catch {
              // A durable retirement remains retryable after an adapter outage.
            }
            if (orphanedBodiesDeleted >= limit) break;
          }
          if (!candidates.after) {
            bodyMaintenanceAfter = undefined;
            break;
          }
        }
      }
      return ({ orphanedBodiesDeleted } as const);
    },

    retireUnownedReadyBody: (input) => retireBody(input, 0),

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

  // A handler's remembered rows must not outlive what these calls change.
  const markDeleted = repository.markDeleted.bind(repository);
  const maintainBodies = repository.maintainBodies.bind(repository);
  Object.assign(repository, {
    async markDeleted(namespace: string, assetId: string) {
      try {
        return await markDeleted(namespace, assetId);
      } finally {
        options.readViews?.invalidate(
          assetViewKey(namespace.trim(), assetId.trim()),
        );
      }
    },
    async maintainBodies(maintenance?: Parameters<typeof maintainBodies>[0]) {
      try {
        return await maintainBodies(maintenance);
      } finally {
        options.readViews?.invalidateAll();
      }
    },
  });

  const frozenRepository = repository;
  collectionAssetAdopters.set(
    frozenRepository,
    {
      prepareInCommand: storage.writer?.kind === "database" &&
        isDatabaseBodyStore(storage.writer) &&
        !promotedReadyStore(storage.writer),
      prepareMaterialization: (input, transaction) =>
        prepareMaterializationOn(transaction ?? options.session, input),
      adoptMaterialization,
      reconcileMaterializations,
      adoptable,
      composeAdoption,
      publishMaterializations,
    } as const,
  );
  return frozenRepository;
}
