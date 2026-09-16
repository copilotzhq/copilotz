import {
  projectVector,
  searchVectors,
  validateVector,
  vectorProfileKey,
  type VectorReader,
  type VectorTransaction,
  type VectorWrite,
} from "../vectors/index.ts";
import { reconcileCollectionContent } from "./content-reconciliation.ts";
import { assertJsonValue } from "../json.ts";
import {
  bindCollectionScope,
  type CollectionOperations,
  createCollectionOperations,
} from "./operations.ts";
import { getPath, setPath } from "./content-path.ts";
import type { ContentResolver } from "../content/resolver.ts";
import type {
  ResolvedCollectionContent,
  ResolvedCollectionFields,
  ScopedCollectionReadOptions,
} from "./read-options.ts";
export type { ScopedCollectionReadOptions } from "./read-options.ts";
import { ulid } from "../../dependencies/ulid.ts";
import { AsyncLocalStorage } from "../../dependencies/async-hooks.ts";
import {
  type CoordinatedMutationResult,
  deriveWorkflowId,
  type DurableEvent,
  type EventCoordinator,
  type EventDispatchReport,
  type EventMutationContext,
  type EventStore,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";
import {
  type AssetManifestEntry,
  type AssetMaterializationPlan,
  type AssetOrigin,
  type ContentInput,
  type ContentRef,
  type ContentSequence,
  createContentPreparer,
  digestContent,
  type DurableContentInput,
  type PreparedAsset,
} from "../content/index.ts";
import {
  eventDataRef,
  readEventBody,
  writeEventBody,
} from "../events/body-store.ts";
import type { CollectionDefinition } from "./definition.ts";
import { sameValue } from "./equal.ts";
import {
  loadGraphRelation,
  mergeGraphRelation,
  normalizeGraphRelation,
  projectGraphRelation,
} from "./relation-reducer.ts";
import { loadCollectionRecord, projectCollectionEvent } from "./reducer.ts";
import { aggregateCollectionRecords } from "./aggregate.ts";
import { queryCollectionRecords, queryCollectionRelations } from "./query.ts";
import {
  rebuildNamespaceProjections,
  verifyCollectionProjections,
} from "./replay.ts";
import type {
  CollectionAggregateQuery,
  CollectionAggregateRow,
  CollectionDurableEvent,
  CollectionEventBody,
  CollectionGraphRelation,
  CollectionMutation,
  CollectionMutationIdentity,
  CollectionMutationIntent,
  CollectionMutationRef,
  CollectionQuery,
  CollectionRecord,
  CollectionRelationQuery,
  CollectionUpdatePatch,
  CollectionWrite,
  CollectionWriteOptions,
  GraphRelationEventBody,
  GraphRelationIntent,
  GraphRelationUpsertInput,
} from "./types.ts";
import {
  validateAgainstJsonSchema,
  validateCollectionRecord,
} from "./validate.ts";

export type CreateCollectionRuntimeOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlSession;
  eventStore: EventStore;
  assets?: CollectionAssetAdopter;
  contentResolver?: ContentResolver;
  createId?: () => string;
  now?: () => Date;
  runtimeProjections?: Readonly<{
    nodeTypes: readonly string[];
    projectBody(
      context: EventMutationContext,
      namespace: string,
      body: unknown,
      event: import("../events/types.ts").DurableEvent,
    ): Promise<void>;
  }>;
}>;

/** Internal content-adoption seam used only by the Collection kernel. */
type CollectionAssetAdopter = Readonly<{
  reconcileMaterializations(
    transaction: SqlExecutor,
    plans: readonly AssetMaterializationPlan[],
  ): Promise<ReadonlyMap<string, AssetManifestEntry>>;

  prepareMaterialization(
    input: Readonly<{
      namespace: string;
      content: DurableContentInput;
      origin?: AssetOrigin;
    }>,
  ): Promise<AssetMaterializationPlan>;
  adoptMaterialization(
    context: EventMutationContext,
    plan: AssetMaterializationPlan,
  ): Promise<void>;
}>;

export type BoundCollectionQuery<TSelect extends object> =
  & ((
    namespace: string,
    query?: CollectionQuery,
  ) => Promise<readonly TSelect[]>)
  & Readonly<
    Record<
      string,
      (
        namespace: string,
        input?: Record<string, unknown>,
        scope?: CollectionScope,
        options?: Pick<ScopedCollectionReadOptions, "signal">,
      ) => Promise<readonly TSelect[]>
    >
  >;

export type BoundCollection<
  TSelect extends CollectionRecord = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  definition: CollectionDefinition;
  create(
    input: TInsert,
    options: CollectionWriteOptions,
  ): Promise<CollectionMutation<TSelect>>;
  update(
    id: string,
    patch: CollectionUpdatePatch<TSelect>,
    options: CollectionWriteOptions,
  ): Promise<CollectionWrite<TSelect>>;
  delete(
    id: string,
    options: CollectionWriteOptions,
  ): Promise<CollectionMutation<TSelect>>;
  mutate(
    id: string,
    command: string,
    input: unknown,
    options: CollectionWriteOptions,
  ): Promise<CollectionWrite<TSelect>>;
  get(id: string, namespace: string): Promise<TSelect | null>;
  list(namespace: string, query?: CollectionQuery): Promise<readonly TSelect[]>;
  aggregate(
    namespace: string,
    query: CollectionAggregateQuery,
  ): Promise<readonly CollectionAggregateRow[]>;
  query: BoundCollectionQuery<TSelect>;
  search(
    namespace: string,
    query: CollectionQuery,
  ): Promise<readonly TSelect[]>;
}>;

export type ScopedCollectionCallOptions = Readonly<
  & Omit<CollectionWriteOptions, "namespace">
  & {
    operationKey?: string;
  }
>;

type UnresolvedReadOptions = Pick<ScopedCollectionReadOptions, "signal">;

export type ScopedCollectionUpdateInput<
  TRecord extends CollectionRecord = CollectionRecord,
> = Readonly<{
  id: string;
  set?: Partial<TRecord>;
  unset?: readonly string[];
}>;

export type ScopedCollectionDeleteInput = Readonly<{ id: string }>;

export type ScopedCollectionCommand<
  TRecord extends CollectionRecord = CollectionRecord,
> = (
  input: Readonly<Record<string, unknown> & { id: string }>,
  options?: ScopedCollectionCallOptions,
) => Promise<TRecord>;

export type ScopedCollectionNamedQuery<
  TRecord extends CollectionRecord = CollectionRecord,
> = (
  input?: Readonly<Record<string, unknown>>,
  options?: UnresolvedReadOptions,
) => Promise<readonly TRecord[]>;

export type ScopedCollection<
  TSelect extends CollectionRecord = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  definition: Readonly<{ name: string; schema: unknown }>;
  create(
    input: TInsert,
    options?: ScopedCollectionCallOptions,
  ): Promise<TSelect>;
  update(
    input: ScopedCollectionUpdateInput<TSelect>,
    options?: ScopedCollectionCallOptions,
  ): Promise<TSelect>;
  delete(
    input: ScopedCollectionDeleteInput,
    options?: ScopedCollectionCallOptions,
  ): Promise<Readonly<{ id: string; deleted: true }>>;
  get<const Fields extends readonly string[]>(
    input: Readonly<{ id: string }>,
    options: ScopedCollectionReadOptions & {
      content: { fields: Fields; byteLimit?: number };
    },
  ): Promise<ResolvedCollectionFields<TSelect | null, Fields[number]>>;
  get(
    input: Readonly<{ id: string }>,
    options?: ScopedCollectionReadOptions<false>,
  ): Promise<TSelect | null>;
  get(
    input: Readonly<{ id: string }>,
    options?: ScopedCollectionReadOptions,
  ): Promise<ResolvedCollectionContent<TSelect | null>>;
  list<const Fields extends readonly string[]>(
    query: CollectionQuery | undefined,
    options: ScopedCollectionReadOptions & {
      content: { fields: Fields; byteLimit?: number };
    },
  ): Promise<ResolvedCollectionFields<readonly TSelect[], Fields[number]>>;
  list(
    query?: CollectionQuery,
    options?: ScopedCollectionReadOptions<false>,
  ): Promise<readonly TSelect[]>;
  list(
    query: CollectionQuery | undefined,
    options?: ScopedCollectionReadOptions,
  ): Promise<ResolvedCollectionContent<readonly TSelect[]>>;
  aggregate(
    query: CollectionAggregateQuery,
    options?: UnresolvedReadOptions,
  ): Promise<readonly CollectionAggregateRow[]>;
  search<const Fields extends readonly string[]>(
    query: CollectionQuery,
    options: ScopedCollectionReadOptions & {
      content: { fields: Fields; byteLimit?: number };
    },
  ): Promise<ResolvedCollectionFields<readonly TSelect[], Fields[number]>>;
  search(
    query: CollectionQuery,
    options?: ScopedCollectionReadOptions<false>,
  ): Promise<readonly TSelect[]>;
  search(
    query: CollectionQuery,
    options?: ScopedCollectionReadOptions,
  ): Promise<ResolvedCollectionContent<readonly TSelect[]>>;
  relations: Readonly<{
    list(
      query?: CollectionRelationQuery,
      options?: UnresolvedReadOptions,
    ): Promise<readonly CollectionGraphRelation[]>;
  }>;
  commands: Readonly<Record<string, ScopedCollectionCommand<TSelect>>>;
  queries: Readonly<Record<string, ScopedCollectionNamedQuery<TSelect>>>;
}>;

export type ScopedCollections = Readonly<Record<string, ScopedCollection>>;

/** The deliberately read-only Collection surface available in a DB snapshot. */
export type SnapshotCollection<
  TSelect extends CollectionRecord = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Pick<
  ScopedCollection<TSelect, TInsert>,
  | "definition"
  | "get"
  | "list"
  | "aggregate"
  | "search"
  | "queries"
  | "relations"
>;

export type SnapshotCollections = Readonly<Record<string, SnapshotCollection>>;

export type CollectionScope = Readonly<{
  namespace: string;
  createMutationIdentity?: (
    operationKey: string,
    metadata?: Record<string, unknown>,
  ) => CollectionMutationIdentity;
}>;

export type TransactionCollection<
  TSelect extends CollectionRecord = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  create(
    input: TInsert,
    options?: ScopedCollectionCallOptions,
  ): Promise<CollectionMutationRef>;
  update(
    input: ScopedCollectionUpdateInput<TSelect>,
    options?: ScopedCollectionCallOptions,
  ): Promise<CollectionMutationRef>;
  delete(
    input: ScopedCollectionDeleteInput,
    options?: ScopedCollectionCallOptions,
  ): Promise<CollectionMutationRef>;
  commands: Readonly<
    Record<
      string,
      (
        input: Readonly<Record<string, unknown> & { id: string }>,
        options?: ScopedCollectionCallOptions,
      ) => Promise<CollectionMutationRef>
    >
  >;
}>;

export type CollectionTransactionCollections = Readonly<
  Record<string, TransactionCollection>
>;

export type CollectionTransactionRelations = Readonly<{
  upsert(
    input: GraphRelationUpsertInput,
    options?: ScopedCollectionCallOptions,
  ): Promise<CollectionMutationRef>;
}>;

export type CollectionTransactionOptions<T> = Readonly<{
  operationKey: string;
  namespace: string;
  identity?: CollectionMutationIdentity;
  execute(
    context: Readonly<{
      collections: CollectionTransactionCollections;
      relations: CollectionTransactionRelations;
      vectors: VectorTransaction;
    }>,
  ): Promise<T>;
}>;

export type CollectionTransactionResult<T> = Readonly<{
  value: T;
  operationKey: string;
  namespace: string;
  settlementScopeId: string;
  correlationId: string;
  writes: readonly CollectionWrite<CollectionRecord>[];
  dispatch: EventDispatchReport;
}>;

export type CollectionKernel = Readonly<{
  vectors(namespace: string): VectorReader;
  bind<
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    definition: CollectionDefinition,
  ): BoundCollection<TSelect, TInsert>;
  get<
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    name: string,
  ): BoundCollection<TSelect, TInsert> | undefined;
  operations(name: string): CollectionOperations | undefined;
  transaction<T>(
    options: CollectionTransactionOptions<T>,
  ): Promise<CollectionTransactionResult<T>>;
  withScope(scope: CollectionScope): ScopedCollections;
  readSnapshot<T>(
    scope: Pick<CollectionScope, "namespace">,
    execute: (
      context: Readonly<{ collections: SnapshotCollections }>,
    ) => T | Promise<T>,
  ): Promise<T>;
  verify(
    definition: CollectionDefinition,
    namespace: string,
  ): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  rebuild(namespace: string): Promise<void>;
}>;

type PreparedWrite = Readonly<{
  body: CollectionEventBody<CollectionRecord>;
  record: CollectionRecord;
}>;

type CollectionMutationPlan = Readonly<{
  write: PreparedWrite;
  content: readonly AssetMaterializationPlan[];
  expected?: CollectionRecord | null;
}>;

const emptyAssetManifest = ([] as const) as readonly AssetManifestEntry[];

function withAssetManifest<T extends CollectionEventBody<CollectionRecord>>(
  body: T,
  assets: readonly AssetManifestEntry[],
): T {
  return ({
    ...body,
    assets: [...assets].map((entry) => structuredClone(entry)),
  }) as T;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function assertLosslessJson(value: unknown, label: string): void {
  assertJsonValue(value, { label, rejectNegativeZero: true });
}

async function canonicalIntentValue(
  value: unknown,
  preparedContentPaths: ReadonlySet<string> = new Set(),
  path: readonly string[] = ([] as const),
  ancestors = new WeakSet<object>(),
): Promise<unknown> {
  if (value === null) return (["null"] as const);
  if (typeof value === "string") return (["string", value] as const);
  if (typeof value === "boolean") {
    return (["boolean", value] as const);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Collection mutation intent numbers must be finite.");
    }
    return ([
      "number",
      Object.is(value, -0) ? "-0" : String(value),
    ] as const);
  }
  if (value === undefined) {
    throw new TypeError("Collection mutation intent cannot contain undefined.");
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return ([
      "bytes",
      await digestContent(bytes),
      bytes.byteLength,
    ] as const);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return ([
      "bytes",
      await digestContent(bytes),
      bytes.byteLength,
    ] as const);
  }
  if (typeof value !== "object") {
    throw new TypeError("Collection mutation intent must be JSON-safe.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Collection mutation intent cannot be cyclic.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(
            "Collection mutation intent arrays cannot be sparse.",
          );
        }
        items.push(
          await canonicalIntentValue(
            value[index],
            preparedContentPaths,
            [...path, String(index)] as const,
            ancestors,
          ),
        );
      }
      return (["array", items] as const);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Collection mutation intent objects must be plain JSON objects.",
      );
    }
    const source = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(source);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError(
        "Collection mutation intent objects cannot contain symbol keys.",
      );
    }
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          "Collection mutation intent objects must contain enumerable data properties only.",
        );
      }
    }
    const isPreparedContent = preparedContentPaths.has(JSON.stringify(path)) &&
      ownKeys.every((key) => key === "content" || key === "assets") &&
      Array.isArray(source.content) && Array.isArray(source.assets) &&
      source.content.every((item) =>
        item && typeof item === "object" && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).assetId === "string" &&
        typeof (item as Record<string, unknown>).kind === "string" &&
        typeof (item as Record<string, unknown>).role === "string" &&
        typeof (item as Record<string, unknown>).mediaType === "string"
      ) &&
      source.assets.every((item) =>
        item && typeof item === "object" && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).namespace === "string" &&
        typeof (item as Record<string, unknown>).mediaType === "string" &&
        typeof (item as Record<string, unknown>).digest === "string" &&
        typeof (item as Record<string, unknown>).byteLength === "number" &&
        (item as Record<string, unknown>).body instanceof Uint8Array
      );
    if (isPreparedContent) {
      const assets = source.assets as readonly PreparedAsset[];
      const preparedRefs = source.content as readonly Record<string, unknown>[];
      const identities = new Map<string, readonly unknown[]>();
      for (const asset of assets) {
        const identity = asset.idempotencyKey?.trim()
          ? (["key", asset.idempotencyKey.trim()] as const)
          : ([
            "digest",
            asset.digest,
            asset.mediaType,
            asset.byteLength,
          ] as const);
        identities.set(asset.id, identity);
      }
      const refs: unknown[] = [];
      for (const ref of preparedRefs) {
        const stableId = identities.get(String(ref.assetId));
        refs.push(
          await canonicalIntentValue(
            {
              ...ref,
              ...(stableId ? { assetId: ["prepared", stableId] as const } : {}),
            },
            new Set(),
            [] as const,
            ancestors,
          ),
        );
      }
      const normalizedAssets: unknown[] = [];
      for (const asset of assets) {
        const {
          id: _id,
          body: _body,
          readyBody: _readyBody,
          location: _location,
          ...fields
        } = asset;
        normalizedAssets.push(
          await canonicalIntentValue(
            {
              identity: identities.get(asset.id),
              ...fields,
            },
            new Set(),
            [] as const,
            ancestors,
          ),
        );
      }
      normalizedAssets.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
      return ([
        "prepared-content",
        refs,
        normalizedAssets,
      ] as const);
    }
    const entries: unknown[] = [];
    for (const key of Object.keys(source).sort()) {
      entries.push(
        [
          key,
          await canonicalIntentValue(
            source[key],
            preparedContentPaths,
            [...path, key] as const,
            ancestors,
          ),
        ] as const,
      );
    }
    return (["object", entries] as const);
  } finally {
    ancestors.delete(value);
  }
}

function applyPatch(
  current: Record<string, unknown>,
  patch: CollectionUpdatePatch<Record<string, unknown>>,
): Record<string, unknown> {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    next[key] = structuredClone(value) as unknown;
  }
  for (const key of patch.unset ?? []) {
    delete next[key];
  }
  return next;
}

function stamp(
  value: Record<string, unknown>,
  options: Readonly<{
    namespace: string;
    id: string;
    createdAt: string;
    updatedAt: string;
    timestamps: Readonly<{ createdAt?: string; updatedAt?: string }>;
    created: boolean;
  }>,
): Record<string, unknown> {
  const createdKey = options.timestamps.createdAt ?? "createdAt";
  const updatedKey = options.timestamps.updatedAt ?? "updatedAt";
  return {
    ...value,
    id: options.id,
    namespace: options.namespace,
    ...(options.created || value[createdKey] === undefined
      ? { [createdKey]: options.createdAt }
      : {}),
    [updatedKey]: options.updatedAt,
  };
}

function applyStaticDefaults(
  definition: CollectionDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(input);
  for (const [key, value] of Object.entries(definition.defaults ?? {})) {
    if (next[key] === undefined) next[key] = structuredClone(value);
  }
  return next;
}

function canonicalEvent(event: DurableEvent): CollectionDurableEvent {
  return ({
    id: event.id,
    position: event.position,
    schemaVersion: event.schemaVersion,
    eventType: event.type,
    namespace: event.namespace,
    ...(event.subject ? { subject: event.subject } : {}),
    metadata: event.metadata,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    correlationId: event.correlationId,
    ...(event.deduplicationId
      ? { deduplicationId: event.deduplicationId }
      : {}),
    dataRef: eventDataRef(event.payload),
    createdAt: event.createdAt,
  } as const);
}

function noopError(record: CollectionRecord): Error {
  return Object.assign(new Error("collection_noop"), {
    name: "CollectionNoop",
    record,
  });
}

function isNoopError(
  error: unknown,
): error is Error & { record: CollectionRecord } {
  return error instanceof Error && error.name === "CollectionNoop" &&
    "record" in error;
}

function mutationResult<TSelect extends object>(
  record: CollectionRecord,
  event: DurableEvent,
  settlementScopeId: string,
  deliveries: CollectionMutation<TSelect>["deliveries"],
  dispatch: CollectionMutation<TSelect>["dispatch"],
  deduplicated: boolean,
): CollectionMutation<TSelect> {
  return ({
    record: (structuredClone(record)) as TSelect,
    event: canonicalEvent(event),
    settlementScopeId,
    deliveries,
    dispatch,
    deduplicated,
  } as const);
}

/** Binds canonical collection commands to the existing event coordinator. */
export function createCollectionKernel(
  options: CreateCollectionRuntimeOptions,
): CollectionKernel {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const tables = options.eventStore.tables;
  const bound = new Map<string, BoundCollection>();
  const operations = new Map<string, CollectionOperations>();
  type TransactionBinding = Readonly<{
    definition: CollectionDefinition;
    create(
      input: Record<string, unknown>,
      writeOptions: CollectionWriteOptions,
      order: readonly number[],
    ): Promise<CollectionMutationRef>;
    update(
      id: string,
      patch: CollectionUpdatePatch<CollectionRecord>,
      writeOptions: CollectionWriteOptions,
      order: readonly number[],
    ): Promise<CollectionMutationRef>;
    delete(
      id: string,
      writeOptions: CollectionWriteOptions,
      order: readonly number[],
    ): Promise<CollectionMutationRef>;
    mutate(
      id: string,
      command: string,
      input: unknown,
      writeOptions: CollectionWriteOptions,
      order: readonly number[],
    ): Promise<CollectionMutationRef>;
  }>;
  const transactionBindings = new Map<string, TransactionBinding>();
  type PlannedTransactionMutation = Readonly<{
    id: string;
    order: readonly number[];
    protectionDeadline?: number;
    commit(
      transaction: SqlExecutor,
      pending: CoordinatedMutationResult<unknown>[],
      replacements: ReadonlyMap<string, AssetManifestEntry>,
    ): Promise<CollectionWrite<CollectionRecord> | undefined>;
  }>;
  type StagedAsset = Readonly<{
    manifest: AssetManifestEntry;
    candidate: PreparedAsset;
    plan: AssetMaterializationPlan;
  }>;
  type TransactionScope = {
    operationKey: string;
    rootIdentity: string;
    namespace: string;
    settlementScopeId: string;
    correlationId: string;
    causationId?: string;
    metadata: Record<string, unknown>;
    plans: PlannedTransactionMutation[];
    records: Map<string, CollectionRecord | null>;
    assets: Map<string, StagedAsset>;
    assetKeys: Map<string, StagedAsset>;
    relations: Map<string, CollectionGraphRelation>;
    invalidatedRelationEndpoints: Set<string>;
    operationPath: readonly string[];
    orderPath: readonly number[];
    identityOccurrences: Map<string, number>;
    orderSequence: number;
    planning: Promise<Readonly<{ ok: true } | { ok: false; error: unknown }>>[];
    planningQueues: Map<string, Promise<void>>;
    state: "open" | "closing" | "closed";
  };
  const transactions = new AsyncLocalStorage<TransactionScope>();
  type SnapshotScope = { executor: SqlExecutor; state: "open" | "closed" };
  const snapshots = new AsyncLocalStorage<SnapshotScope>();
  const activeScope = () => transactions.getStore();
  const activeSnapshot = () => snapshots.getStore();

  const comparePlanOrder = (
    left: PlannedTransactionMutation,
    right: PlannedTransactionMutation,
  ): number => {
    const length = Math.max(left.order.length, right.order.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = left.order[index];
      const rightPart = right.order[index];
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      if (leftPart !== rightPart) return leftPart - rightPart;
    }
    return 0;
  };

  const beginPlanning = <T>(
    scope: TransactionScope,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (scope.state !== "open") {
      return Promise.reject(
        new Error("Transaction mutation planning is already closed."),
      );
    }
    let promise: Promise<T>;
    try {
      promise = (scope.planningQueues.get(key) ?? Promise.resolve()).then(
        operation,
      );
    } catch (error) {
      promise = Promise.reject(error);
    }
    scope.planningQueues.set(
      key,
      promise.then(() => undefined, () => undefined),
    );
    scope.planning.push(promise.then(
      () => ({ ok: true as const } as const),
      (error) => ({ ok: false as const, error } as const),
    ));
    return promise;
  };

  const finishPlanning = async <T>(
    scope: TransactionScope,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let value: T | undefined;
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      value = await transactions.run(scope, operation);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
    scope.state = "closing";
    const settled = await Promise.all(scope.planning);
    scope.state = "closed";
    if (callbackFailed) throw callbackError;
    const failed = settled.find((item) => !item.ok);
    if (failed && !failed.ok) throw failed.error;
    return value as T;
  };

  const executor = (): SqlExecutor => {
    const snapshot = activeSnapshot();
    if (!snapshot) return options.session;
    if (snapshot.state !== "open") {
      throw new Error("Read snapshot access has already closed.");
    }
    return snapshot.executor;
  };

  const scopedWriteOptions = (
    writeOptions: CollectionWriteOptions,
    collectionName: string,
    operation: string,
    subjectId: string,
  ): CollectionWriteOptions => {
    const scope = activeScope();
    const namespace = requireText(writeOptions.namespace, "Namespace");
    if (scope && namespace !== scope.namespace) {
      throw new TypeError(
        `Collection write namespace '${namespace}' does not match transaction namespace '${scope.namespace}'.`,
      );
    }
    if (!scope) return writeOptions;
    const inherited = writeOptions.identity;
    return {
      namespace,
      metadata: writeOptions.metadata,
      identity: {
        settlementScopeId: inherited?.settlementScopeId ??
          scope.settlementScopeId,
        correlationId: inherited?.correlationId ?? scope.correlationId,
        ...(inherited?.causationId ?? scope.causationId
          ? { causationId: inherited?.causationId ?? scope.causationId }
          : {}),
        deduplicationId: inherited?.deduplicationId ??
          `${scope.operationKey}:${collectionName}:${operation}:${subjectId}`,
        metadata: { ...scope.metadata, ...inherited?.metadata },
      },
    };
  };

  const bind = <
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    definition: CollectionDefinition,
  ): BoundCollection<TSelect, TInsert> => {
    if (bound.has(definition.name)) {
      throw new TypeError(`Collection '${definition.name}' is already bound.`);
    }
    const name = definition.name;
    const timestamps = definition.timestamps ?? {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    };
    const createdAtKey = timestamps.createdAt ?? "createdAt";
    const updatedAtKey = timestamps.updatedAt ?? "updatedAt";
    const contentIntentPaths = new Set(
      (definition.content?.fields ?? []).map((field) =>
        JSON.stringify(field.split(".").filter(Boolean))
      ),
    );
    const canonicalIntent = (value: unknown) =>
      canonicalIntentValue(value, contentIntentPaths);
    const candidateIdentity = (
      candidate: PreparedAsset,
      includeOwnership: boolean,
    ): unknown => ({
      ...(includeOwnership ? { id: candidate.id } : {}),
      namespace: candidate.namespace,
      mediaType: candidate.mediaType,
      byteLength: candidate.byteLength,
      digest: candidate.digest,
      idempotencyKey: candidate.idempotencyKey?.trim() || undefined,
      ...(includeOwnership
        ? {
          origin: candidate.origin,
          metadata: candidate.metadata,
          location: candidate.location,
          readyBody: candidate.readyBody
            ? {
              bodyId: candidate.readyBody.bodyId,
              state: candidate.readyBody.state,
              mediaType: candidate.readyBody.mediaType,
              byteLength: candidate.readyBody.byteLength,
              digest: candidate.readyBody.digest,
            }
            : undefined,
        }
        : {}),
    });
    const assertStagedCandidate = (
      staged: StagedAsset,
      candidate: PreparedAsset,
      mode: "id" | "key",
    ): void => {
      if (
        !sameValue(
          candidateIdentity(staged.candidate, mode === "id"),
          candidateIdentity(candidate, mode === "id"),
        )
      ) {
        throw new Error(
          mode === "id"
            ? `Prepared Asset '${candidate.id}' conflicts with an earlier transaction mutation.`
            : `Prepared Asset idempotency key '${candidate.idempotencyKey}' was reused with different content.`,
        );
      }
    };
    const assertStagedRef = (
      staged: StagedAsset,
      ref: ContentRef,
    ): void => {
      if (ref.mediaType !== staged.manifest.mediaType) {
        throw new Error(
          `Content ref '${ref.assetId}' media type conflicts with its staged Asset.`,
        );
      }
    };
    const registerMaterialization = (
      scope: TransactionScope,
      plan: AssetMaterializationPlan,
    ): void => {
      for (const manifest of plan.assets) {
        const adoption = plan.adoptions.find((item) =>
          item.asset.id === manifest.assetId
        );
        if (!adoption) {
          throw new Error(
            `Asset materialization '${manifest.assetId}' has no adoption plan.`,
          );
        }
        const staged = {
          manifest,
          candidate: adoption.candidate,
          plan,
        } as const;
        const byId = scope.assets.get(manifest.assetId);
        if (byId) {
          assertStagedCandidate(byId, adoption.candidate, "id");
          continue;
        }
        const key = adoption.candidate.idempotencyKey?.trim();
        const byKey = key ? scope.assetKeys.get(key) : undefined;
        if (byKey) {
          assertStagedCandidate(byKey, adoption.candidate, "key");
          throw new Error(
            `Asset materialization key '${key}' was not remapped before preparation.`,
          );
        }
        scope.assets.set(manifest.assetId, staged);
        if (key) scope.assetKeys.set(key, staged);
      }
    };
    const assertStandaloneWrite = (): void => {
      if (activeSnapshot()) {
        throw new Error(
          "Collection mutations are not allowed inside a read snapshot.",
        );
      }
      if (activeScope()) {
        throw new Error(
          `Use transaction.collections.${name} inside context.transaction().`,
        );
      }
    };

    const prepareDeclaredContent = async (
      write: PreparedWrite,
      namespace: string,
      expected?: CollectionRecord | null,
      emitNoChange = false,
    ): Promise<CollectionMutationPlan> => {
      const declaredFields = definition.content?.fields ?? [];
      const fields = write.body.operation === "create"
        ? declaredFields
        : write.body.operation === "update" && expected
        ? declaredFields.filter((field) =>
          !sameValue(getPath(expected, field), getPath(write.record, field))
        )
        : [];
      if (fields.length === 0) {
        return ({
          write,
          content: [] as const,
          ...(expected !== undefined ? { expected } : {}),
        } as const);
      }
      if (!options.assets) {
        throw new Error(
          `Collection '${name}' declares content fields but no content asset repository is configured.`,
        );
      }
      const record = structuredClone(write.record) as Record<string, unknown>;
      const assets: AssetManifestEntry[] = [...write.body.assets];
      const content: AssetMaterializationPlan[] = [];
      let changed = false;
      for (const field of fields) {
        let value = getPath(record, field);
        if (value === undefined) continue;
        const scope = activeScope();
        let preparedValue = Array.isArray(value) && value.every((item) =>
            item && typeof item === "object" &&
            typeof (item as Record<string, unknown>).assetId === "string"
          )
          ? {
            content: value as ContentSequence,
            assets: ([] as const) as readonly PreparedAsset[],
            sequenceOnly: true,
          }
          : value && typeof value === "object" && !Array.isArray(value) &&
              Array.isArray((value as Record<string, unknown>).content) &&
              Array.isArray((value as Record<string, unknown>).assets)
          ? {
            content: (value as { content: ContentSequence }).content,
            assets: (value as { assets: readonly PreparedAsset[] }).assets,
            sequenceOnly: false,
          }
          : undefined;
        if (!preparedValue) {
          const source = await createContentPreparer().prepare(
            value as ContentInput | readonly ContentInput[],
            { namespace, origin: { type: name, id: write.record.id } },
          );
          // Content identity survives retries without coupling it to an Action or
          // generating a new Asset each time the collection plan is rebuilt.
          const candidates = source.assets.map((asset) => ({
            ...asset,
            idempotencyKey: JSON.stringify([
              "collection-content",
              asset.mediaType,
              asset.digest,
            ]),
          } as const));
          value = { content: source.content, assets: candidates };
          preparedValue = {
            content: source.content,
            assets: candidates,
            sequenceOnly: false,
          };
        }
        if (preparedValue && scope) {
          const remappedCandidates = new Map<string, StagedAsset>();
          const pendingAssets: PreparedAsset[] = [];
          for (const candidate of preparedValue.assets) {
            const byId = scope.assets.get(candidate.id);
            if (byId) {
              assertStagedCandidate(byId, candidate, "id");
              remappedCandidates.set(candidate.id, byId);
              continue;
            }
            const key = candidate.idempotencyKey?.trim();
            const byKey = key ? scope.assetKeys.get(key) : undefined;
            if (byKey) {
              assertStagedCandidate(byKey, candidate, "key");
              remappedCandidates.set(candidate.id, byKey);
              continue;
            }
            pendingAssets.push(candidate);
          }
          const rebuilt: ContentRef[] = new Array(
            preparedValue.content.length,
          );
          const pendingRefs: ContentRef[] = [];
          const pendingIndexes: number[] = [];
          preparedValue.content.forEach((ref, index) => {
            const staged = scope.assets.get(ref.assetId) ??
              remappedCandidates.get(ref.assetId);
            if (staged) {
              assertStagedRef(staged, ref);
              rebuilt[index] = {
                ...structuredClone(ref),
                assetId: staged.manifest.assetId,
              } as const;
              return;
            }
            pendingRefs.push(ref);
            pendingIndexes.push(index);
          });
          const pendingAssetIds = new Set(
            pendingRefs.map((ref) =>
              ref.assetId
            ),
          );
          const unusedCandidate = pendingAssets.find((candidate) =>
            !pendingAssetIds.has(candidate.id)
          );
          if (unusedCandidate) {
            throw new Error(
              `Prepared content contains unused Asset candidate '${unusedCandidate.id}'.`,
            );
          }
          if (pendingRefs.length > 0) {
            const pending = await options.assets.prepareMaterialization({
              namespace,
              content: preparedValue.sequenceOnly ? pendingRefs : ({
                content: pendingRefs,
                assets: pendingAssets,
              } as const),
              origin: { type: name, id: write.record.id },
            });
            if (pending.content.length !== pendingIndexes.length) {
              throw new Error(
                "Asset materialization changed the content sequence length.",
              );
            }
            registerMaterialization(scope, pending);
            content.push(pending);
            assets.push(...pending.assets);
            pendingIndexes.forEach((index, pendingIndex) => {
              rebuilt[index] = pending.content[pendingIndex];
            });
          }
          for (let index = 0; index < rebuilt.length; index += 1) {
            if (!rebuilt[index]) {
              throw new Error(
                `Prepared content is missing a resolved Asset at index ${index}.`,
              );
            }
          }
          setPath(record, field, rebuilt);
          changed = true;
          continue;
        }
        const input = {
          namespace,
          content: value as DurableContentInput,
          origin: { type: name, id: write.record.id },
        } as const;
        const prepared = await options.assets.prepareMaterialization(input);
        content.push(prepared);
        assets.push(...prepared.assets);
        setPath(record, field, prepared.content);
        changed = true;
      }
      if (!changed && assets.length === write.body.assets.length) {
        return ({
          write,
          content: content,
          ...(expected !== undefined ? { expected } : {}),
        } as const);
      }
      let frozen = record as CollectionRecord;
      if (write.body.operation === "update" && expected) {
        const comparable = {
          ...frozen,
          [updatedAtKey]: expected[updatedAtKey],
        };
        if (sameValue(comparable, expected)) {
          if (!emitNoChange) throw noopError(expected);
          frozen = expected;
        }
      }
      let preparedWrite: PreparedWrite;
      if (write.body.operation === "create") {
        preparedWrite = {
          record: frozen,
          body: withAssetManifest(
            {
              operation: "create",
              intent: write.body.intent,
              record: frozen,
              assets: emptyAssetManifest,
            },
            assets,
          ),
        } as const;
      } else if (write.body.operation === "delete") {
        preparedWrite = {
          record: frozen,
          body: withAssetManifest(
            {
              operation: "delete",
              intent: write.body.intent,
              id: write.body.id,
              record: frozen,
              assets: emptyAssetManifest,
            },
            assets,
          ),
        } as const;
      } else {
        const sameRecord = expected === frozen;
        const set = sameRecord
          ? {}
          : { ...(write.body.set ?? {}) } as Record<string, unknown>;
        if (!sameRecord) {
          for (const field of fields) {
            if (getPath(frozen, field) !== undefined) {
              setPath(set, field, getPath(frozen, field));
            }
          }
        }
        preparedWrite = {
          record: frozen,
          body: withAssetManifest({
            operation: "update",
            intent: write.body.intent,
            id: write.body.id,
            set,
            unset: sameRecord ? ([] as const) : write.body.unset,
            record: frozen,
            assets: emptyAssetManifest,
          }, assets),
        } as const;
      }
      return ({
        write: preparedWrite,
        content: content,
        ...(expected !== undefined ? { expected } : {}),
      } as const);
    };

    const commit = async (
      eventType: string,
      subjectId: string,
      operation: string,
      writeOptions: CollectionWriteOptions,
      plan: CollectionMutationPlan,
      matchData?: unknown,
      execution?: Readonly<{
        transaction: SqlExecutor;
        pending: CoordinatedMutationResult<unknown>[];
      }>,
    ): Promise<CollectionMutation<TSelect>> => {
      if (
        !execution && options.assets &&
        plan.content.some((item) => item.adoptions.length)
      ) {
        const pending: CoordinatedMutationResult<unknown>[] = [];
        const result = await options.session.transaction(
          async (transaction) => {
            const replacements = await options.assets!
              .reconcileMaterializations(transaction, plan.content);
            const resolved = reconcileCollectionContent(
              plan,
              definition.content?.fields ?? [],
              replacements,
            );
            return await commit(
              eventType,
              subjectId,
              operation,
              writeOptions,
              resolved,
              matchData === undefined ? undefined : resolved.write.body,
              { transaction, pending },
            );
          },
        );
        const reports = [];
        for (const item of pending) {
          reports.push(await options.coordinator.flushCommitted(item));
        }
        return ({
          ...result,
          dispatch: {
            handles: reports.flatMap((report) => [...report.handles]),
            failures: reports.flatMap((report) => [...report.failures]),
          } as const,
        } as const);
      }
      const scoped = scopedWriteOptions(
        writeOptions,
        name,
        operation,
        subjectId,
      );
      const identity = scoped.identity;
      const dedup = identity?.deduplicationId?.trim();
      const bodyId = dedup
        ? `event-body:${scoped.namespace}:${dedup}`
        : createId();
      assertLosslessJson(plan.write.record, `${name} ${operation}`);
      validateCollectionRecord(
        definition.schema as object,
        plan.write.record,
        `${name} ${operation}`,
      );
      const draft = {
        type: eventType,
        namespace: scoped.namespace,
        subject: { type: name, id: subjectId },
        payload: {
          dataRef: {
            eventBodyId: bodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        metadata: structuredClone({
          ...identity?.metadata,
          ...scoped.metadata,
        }),
        causationId: identity?.causationId,
        correlationId: identity?.correlationId,
        deduplicationId: identity?.deduplicationId,
        settlementScopeId: identity?.settlementScopeId,
      };
      const result = await options.coordinator.commitMutation({
        draft,
        ...(execution ? { transaction: execution.transaction } : {}),
        dispatch: execution ? false : true,
        ...(matchData === undefined ? {} : {
          matchData,
        }),
        mutate: async (context) => {
          if ("expected" in plan) {
            const current = await loadCollectionRecord(
              context.transaction,
              tables,
              scoped.namespace,
              name,
              subjectId,
              true,
            );
            if (plan.expected === null ? current !== null : !current) {
              throw new Error(
                plan.expected === null
                  ? `Collection '${name}' '${subjectId}' was created while its mutation was prepared.`
                  : `Unknown ${name} '${subjectId}'.`,
              );
            }
            if (
              plan.expected !== null &&
              !sameValue(current, plan.expected)
            ) {
              throw new Error(
                `Collection '${name}' '${subjectId}' changed while its mutation was prepared.`,
              );
            }
          }
          for (const content of plan.content) {
            await options.assets!.adoptMaterialization(context, content);
          }
          await writeEventBody(context, {
            namespace: scoped.namespace,
            id: bodyId,
            json: plan.write.body,
          });
          await projectCollectionEvent(context, definition, plan.write.body);
          return plan.write.record;
        },
        recoverDuplicate: async (event, context) => {
          if (!event.subject?.id) {
            throw new Error(`Deduplicated ${name} event is missing a subject.`);
          }
          const existingBody = await readEventBody<
            CollectionEventBody<CollectionRecord>
          >(context, event.namespace, eventDataRef(event.payload));
          if (matchData !== undefined) {
            const plannedIntent = (matchData as CollectionEventBody<
              CollectionRecord
            >).intent;
            if (
              !plannedIntent || !sameValue(existingBody.intent, plannedIntent)
            ) {
              throw new Error(
                "Deduplicated event was reused with a different collection mutation.",
              );
            }
          }
          return existingBody.record;
        },
      });
      if (execution) {
        execution.pending.push(result as CoordinatedMutationResult<unknown>);
      }
      return mutationResult(
        result.value as CollectionRecord,
        result.event,
        result.settlementScopeId,
        result.deliveries,
        result.dispatch,
        result.deduplicated,
      );
    };

    type PlannedCollectionOperation = Readonly<{
      id: string;
      eventType: string;
      operation: string;
      writeOptions: CollectionWriteOptions;
      plan: CollectionMutationPlan;
      matchData?: unknown;
    }>;

    const replayOperation = async (
      eventType: string,
      id: string,
      operation: string,
      writeOptions: CollectionWriteOptions,
      intent: CollectionMutationIntent,
    ): Promise<PlannedCollectionOperation | null> => {
      const scoped = scopedWriteOptions(
        writeOptions,
        name,
        operation,
        id,
      );
      const deduplicationId = scoped.identity?.deduplicationId?.trim();
      if (!deduplicationId) return null;
      const event = await options.eventStore.getEventByDeduplicationId(
        scoped.namespace,
        deduplicationId,
      );
      if (!event) return null;
      if (
        event.type !== eventType || event.subject?.type !== name ||
        event.subject.id !== id
      ) {
        throw new Error(
          `Collection transaction identity '${deduplicationId}' was reused by another mutation.`,
        );
      }
      const body = await readEventBody<CollectionEventBody<CollectionRecord>>(
        { transaction: options.session, tables },
        scoped.namespace,
        eventDataRef(event.payload),
      );
      if (!body.intent || !sameValue(body.intent, intent)) {
        throw new Error(
          `Collection transaction identity '${deduplicationId}' was reused with another intent.`,
        );
      }
      return ({
        id,
        eventType,
        operation,
        writeOptions: scopedWriteOptions(
          writeOptions,
          name,
          operation,
          id,
        ),
        plan: {
          write: { body, record: body.record } as const,
          content: [] as const,
        } as const,
        matchData: body,
      } as const);
    };

    const commitOperation = (
      planned: PlannedCollectionOperation,
      execution?: Readonly<{
        transaction: SqlExecutor;
        pending: CoordinatedMutationResult<unknown>[];
      }>,
    ) =>
      commit(
        planned.eventType,
        planned.id,
        planned.operation,
        planned.writeOptions,
        planned.plan,
        planned.matchData,
        execution,
      );

    const recordKey = (id: string) => `${name}\u0000${id}`;

    const stageOperation = (
      planned: PlannedCollectionOperation,
      order: readonly number[],
    ): CollectionMutationRef => {
      const scope = activeScope();
      if (!scope) {
        throw new Error("Collection mutation planning requires a transaction.");
      }
      assertLosslessJson(
        planned.plan.write.record,
        `${name} ${planned.operation}`,
      );
      const deadlines: number[] = [];
      for (const materialization of planned.plan.content) {
        for (const adoption of materialization.adoptions) {
          if (adoption.kind !== "ready" || !adoption.protectionRequired) {
            continue;
          }
          const protectedUntil = adoption.candidate.readyBody?.protectedUntil;
          const deadline = protectedUntil ? Date.parse(protectedUntil) : NaN;
          if (!Number.isFinite(deadline) || deadline <= Date.now()) {
            throw new Error(
              `Prepared external body for Asset '${adoption.asset.id}' has no valid future protection.`,
            );
          }
          deadlines.push(deadline);
        }
      }
      scope.plans.push(
        {
          id: planned.id,
          order: [...order] as const,
          ...(deadlines.length
            ? { protectionDeadline: Math.min(...deadlines) }
            : {}),
          commit: (transaction, pending, replacements) => {
            const plan = reconcileCollectionContent(
              planned.plan,
              definition.content?.fields ?? [],
              replacements,
            );
            return commitOperation({
              ...planned,
              plan,
              matchData: planned.matchData === undefined
                ? undefined
                : plan.write.body,
            }, { transaction, pending }) as Promise<
              CollectionWrite<CollectionRecord>
            >;
          },
        } as const,
      );
      scope.records.set(
        recordKey(planned.id),
        planned.plan.write.body.operation === "delete"
          ? null
          : planned.plan.write.record,
      );
      if (planned.plan.write.body.operation === "delete") {
        const endpoint = recordKey(planned.id);
        scope.invalidatedRelationEndpoints.add(endpoint);
        for (const [relationId, relation] of scope.relations) {
          if (
            `${relation.source.type}\u0000${relation.source.id}` === endpoint ||
            `${relation.target.type}\u0000${relation.target.id}` === endpoint
          ) {
            scope.relations.delete(relationId);
          }
        }
      }
      return ({ id: planned.id } as const);
    };

    const loadPlanRecord = async (
      id: string,
      namespace: string,
    ): Promise<CollectionRecord | null> => {
      const scope = activeScope();
      const key = recordKey(id);
      if (scope?.records.has(key)) return scope.records.get(key) ?? null;
      const record = await loadCollectionRecord(
        options.session,
        tables,
        namespace,
        name,
        id,
      );
      const snapshot = record
        ? (structuredClone(record)) as CollectionRecord
        : null;
      scope?.records.set(key, snapshot);
      return snapshot;
    };

    const planCreate = async (
      input: TInsert,
      writeOptions: CollectionWriteOptions,
      suppliedIntent?: CollectionMutationIntent,
    ): Promise<PlannedCollectionOperation> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const timestamp = now().toISOString();
      const seeded = applyStaticDefaults(definition, asRecord(input));
      const id = requireText(String(seeded.id ?? createId()), `${name} id`);
      const intent = suppliedIntent ?? ({
        operation: "create" as const,
        input: await canonicalIntent({ ...seeded, id }),
      } as const);
      let record = stamp(seeded, {
        namespace,
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        timestamps,
        created: true,
      });
      if (definition.beforeCreate) {
        record = stamp(
          definition.beforeCreate(structuredClone(record), { namespace }),
          {
            namespace,
            id,
            createdAt: String(record[createdAtKey]),
            updatedAt: timestamp,
            timestamps,
            created: true,
          },
        );
      }
      const frozen = (structuredClone(record)) as CollectionRecord;
      const body = withAssetManifest({
        operation: "create" as const,
        intent,
        record: frozen,
        assets: emptyAssetManifest,
      }, emptyAssetManifest);
      const plan = await prepareDeclaredContent(
        { body, record: frozen },
        namespace,
        null,
      );
      return ({
        id,
        eventType: `${name}.created`,
        operation: "create",
        writeOptions: scopedWriteOptions(
          writeOptions,
          name,
          "create",
          id,
        ),
        plan,
        matchData: plan.write.body,
      } as const);
    };

    const create = async (
      input: TInsert,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionMutation<TSelect>> => {
      assertStandaloneWrite();
      const snapshot = structuredClone(input) as TInsert;
      const optionsSnapshot = structuredClone(writeOptions);
      const rawId = (snapshot as Record<string, unknown>).id;
      const deduplicationId = optionsSnapshot.identity?.deduplicationId?.trim();
      const id = typeof rawId === "string" && rawId.trim()
        ? rawId.trim()
        : deduplicationId
        ? await deriveWorkflowId(
          "record",
          JSON.stringify([
            optionsSnapshot.namespace,
            name,
            deduplicationId,
          ]),
        )
        : undefined;
      const value = id
        ? { ...snapshot as Record<string, unknown>, id } as TInsert
        : snapshot;
      const intent: CollectionMutationIntent = {
        operation: "create",
        input: await canonicalIntent(value),
      } as const;
      const subjectId = id ?? requireText(
        String((value as Record<string, unknown>).id ?? createId()),
        `${name} id`,
      );
      const planned = await replayOperation(
        `${name}.created`,
        subjectId,
        "create",
        optionsSnapshot,
        intent,
      ) ?? await planCreate(
        { ...value as Record<string, unknown>, id: subjectId } as TInsert,
        optionsSnapshot,
        intent,
      );
      return await commitOperation(planned);
    };

    const prepareUpdate = (
      current: CollectionRecord,
      patch: CollectionUpdatePatch<TSelect>,
      label: string,
      intent: CollectionMutationIntent,
      emitNoChange = false,
    ): PreparedWrite => {
      const timestamp = now().toISOString();
      let next = applyPatch(
        current,
        patch as CollectionUpdatePatch<Record<string, unknown>>,
      );
      next = stamp(next, {
        namespace: current.namespace,
        id: current.id,
        createdAt: String(current[createdAtKey]),
        updatedAt: timestamp,
        timestamps,
        created: false,
      });
      if (definition.beforeUpdate && label === "update") {
        next = stamp(
          definition.beforeUpdate(next, {
            namespace: current.namespace,
          }),
          {
            namespace: current.namespace,
            id: current.id,
            createdAt: String(current[createdAtKey]),
            updatedAt: timestamp,
            timestamps,
            created: false,
          },
        );
      }
      const comparable = {
        ...current,
        [updatedAtKey]: next[updatedAtKey],
      };
      if (sameValue(comparable, next)) {
        if (!emitNoChange) throw noopError(current);
        return {
          body: {
            operation: "update",
            intent,
            id: current.id,
            set: {} as const,
            unset: [] as const,
            record: current,
            assets: emptyAssetManifest,
          },
          record: current,
        };
      }
      const frozen = (structuredClone(next)) as CollectionRecord;
      return {
        body: {
          operation: "update",
          intent,
          id: current.id,
          set: { ...(patch.set ?? {}) } as Partial<CollectionRecord>,
          unset: [...(patch.unset ?? [])] as const,
          record: frozen,
          assets: emptyAssetManifest,
        },
        record: frozen,
      };
    };

    const planUpdate = async (
      idInput: string,
      patch: CollectionUpdatePatch<TSelect>,
      writeOptions: CollectionWriteOptions,
      suppliedIntent?: CollectionMutationIntent,
      emitNoChange = false,
    ): Promise<PlannedCollectionOperation> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      const intent = suppliedIntent ?? ({
        operation: "update" as const,
        id,
        set: await canonicalIntent(patch.set ?? {}),
        unset: [...(patch.unset ?? [])] as const,
      } as const);
      const preview = await loadPlanRecord(id, namespace);
      if (!preview) throw new Error(`Unknown ${name} '${id}'.`);
      const plan = await prepareDeclaredContent(
        prepareUpdate(preview, patch, "update", intent, emitNoChange),
        namespace,
        preview,
        emitNoChange,
      );
      return ({
        id,
        eventType: `${name}.updated`,
        operation: "update",
        writeOptions: scopedWriteOptions(
          writeOptions,
          name,
          "update",
          id,
        ),
        plan,
        matchData: plan.write.body,
      } as const);
    };

    const update = async (
      idInput: string,
      patch: CollectionUpdatePatch<TSelect>,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionWrite<TSelect>> => {
      assertStandaloneWrite();
      const id = requireText(idInput, `${name} id`);
      const patchSnapshot = structuredClone(patch);
      const optionsSnapshot = structuredClone(writeOptions);
      const intent: CollectionMutationIntent = {
        operation: "update",
        id,
        set: await canonicalIntent(patchSnapshot.set ?? {}),
        unset: [...(patchSnapshot.unset ?? [])] as const,
      } as const;
      const keyed = Boolean(
        optionsSnapshot.identity?.deduplicationId?.trim(),
      );
      try {
        return await commitOperation(
          await replayOperation(
            `${name}.updated`,
            id,
            "update",
            optionsSnapshot,
            intent,
          ) ?? await planUpdate(
            id,
            patchSnapshot,
            optionsSnapshot,
            intent,
            keyed,
          ),
        );
      } catch (error) {
        if (isNoopError(error)) {
          return ({
            record: error.record as TSelect,
            noop: true as const,
          } as const);
        }
        throw error;
      }
    };

    const planRemove = async (
      idInput: string,
      writeOptions: CollectionWriteOptions,
      suppliedIntent?: CollectionMutationIntent,
    ): Promise<PlannedCollectionOperation> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      const intent = suppliedIntent ?? ({
        operation: "delete" as const,
        id,
      } as const);
      const preview = await loadPlanRecord(id, namespace);
      if (!preview) throw new Error(`Unknown ${name} '${id}'.`);
      definition.beforeDelete?.(structuredClone(preview), { namespace });
      const plan = await prepareDeclaredContent(
        {
          body: withAssetManifest({
            operation: "delete",
            intent,
            id,
            record: preview,
            assets: emptyAssetManifest,
          }, emptyAssetManifest),
          record: preview,
        },
        namespace,
        preview,
      );
      return ({
        id,
        eventType: `${name}.deleted`,
        operation: "delete",
        writeOptions: scopedWriteOptions(
          writeOptions,
          name,
          "delete",
          id,
        ),
        plan,
        matchData: plan.write.body,
      } as const);
    };

    const remove = async (
      idInput: string,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionMutation<TSelect>> => {
      assertStandaloneWrite();
      const id = requireText(idInput, `${name} id`);
      const optionsSnapshot = structuredClone(writeOptions);
      const intent: CollectionMutationIntent = {
        operation: "delete",
        id,
      } as const;
      return await commitOperation(
        await replayOperation(
          `${name}.deleted`,
          id,
          "delete",
          optionsSnapshot,
          intent,
        ) ?? await planRemove(id, optionsSnapshot, intent),
      );
    };

    const planMutate = async (
      idInput: string,
      commandInput: string,
      input: unknown,
      writeOptions: CollectionWriteOptions,
      suppliedIntent?: CollectionMutationIntent,
      emitNoChange = false,
    ): Promise<PlannedCollectionOperation> => {
      const command = requireText(commandInput, `${name} command`);
      const definitionCommand = definition.commands?.[command];
      if (!definitionCommand) {
        throw new Error(`Unknown ${name} command '${command}'.`);
      }
      if (
        definitionCommand.input && typeof definitionCommand.input === "object"
      ) {
        validateCollectionRecord(
          definitionCommand.input,
          asRecord(input),
          `${name}.${command} input`,
        );
      }
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      const intent = suppliedIntent ?? ({
        operation: "command" as const,
        id,
        name: command,
        input: await canonicalIntent(input),
      } as const);
      const applyCommand = (current: CollectionRecord): PreparedWrite => {
        const patch = definitionCommand.mutate({
          current: structuredClone(current),
          input,
        });
        if (!patch && !emitNoChange) throw noopError(current);
        return prepareUpdate(
          current,
          (patch ?? { set: {} }) as CollectionUpdatePatch<TSelect>,
          "mutate",
          intent,
          emitNoChange,
        );
      };
      const preview = await loadPlanRecord(id, namespace);
      if (!preview) throw new Error(`Unknown ${name} '${id}'.`);
      const plan = await prepareDeclaredContent(
        applyCommand(preview),
        namespace,
        preview,
        emitNoChange,
      );
      return ({
        id,
        eventType: definitionCommand.event ?? `${name}.updated`,
        operation: `mutate:${command}`,
        writeOptions: scopedWriteOptions(
          writeOptions,
          name,
          `mutate:${command}`,
          id,
        ),
        plan,
        matchData: plan.write.body,
      } as const);
    };

    const mutate = async (
      idInput: string,
      commandInput: string,
      input: unknown,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionWrite<TSelect>> => {
      assertStandaloneWrite();
      const id = requireText(idInput, `${name} id`);
      const command = requireText(commandInput, `${name} command`);
      const commandDefinition = definition.commands?.[command];
      if (!commandDefinition) {
        throw new Error(`Unknown ${name} command '${command}'.`);
      }
      const value = structuredClone(input);
      const optionsSnapshot = structuredClone(writeOptions);
      if (
        commandDefinition.input && typeof commandDefinition.input === "object"
      ) {
        validateCollectionRecord(
          commandDefinition.input,
          asRecord(value),
          `${name}.${command} input`,
        );
      }
      const intent: CollectionMutationIntent = {
        operation: "command",
        id,
        name: command,
        input: await canonicalIntent(value),
      } as const;
      const keyed = Boolean(
        optionsSnapshot.identity?.deduplicationId?.trim(),
      );
      const eventType = commandDefinition.event ?? `${name}.updated`;
      try {
        return await commitOperation(
          await replayOperation(
            eventType,
            id,
            `mutate:${command}`,
            optionsSnapshot,
            intent,
          ) ?? await planMutate(
            id,
            command,
            value,
            optionsSnapshot,
            intent,
            keyed,
          ),
        );
      } catch (error) {
        if (isNoopError(error)) {
          return ({
            record: error.record as TSelect,
            noop: true as const,
          } as const);
        }
        throw error;
      }
    };

    const read = (id: string, namespace: string) =>
      loadCollectionRecord(
        executor(),
        tables,
        requireText(namespace, "Namespace"),
        name,
        requireText(id, `${name} id`),
      ) as Promise<TSelect | null>;

    const list = (namespace: string, query?: CollectionQuery) =>
      queryCollectionRecords(
        executor(),
        tables,
        definition,
        requireText(namespace, "Namespace"),
        query,
      ) as Promise<readonly TSelect[]>;

    const aggregate = (namespace: string, query: CollectionAggregateQuery) =>
      aggregateCollectionRecords(
        executor(),
        tables,
        definition,
        requireText(namespace, "Namespace"),
        query,
      );

    const namedQueries = Object.fromEntries(
      Object.entries(definition.queries ?? {}).map(([queryName, spec]) => [
        queryName,
        async (
          namespace: string,
          input: Record<string, unknown> = {},
          scope: CollectionScope = { namespace },
          readOptions?: Pick<ScopedCollectionReadOptions, "signal">,
        ) => {
          scope = { ...scope, namespace } as const;
          const queryInput = asRecord(input);
          if (spec.inputSchema) {
            validateAgainstJsonSchema(
              spec.inputSchema,
              queryInput,
              `${name}.${queryName} input`,
            );
          }
          let output: readonly TSelect[];
          if (spec.select) {
            const target = (name: string) => {
              const collection = operations.get(name);
              if (!collection) {
                throw new Error(`Collection '${name}' is not bound.`);
              }
              return collection;
            };
            const controls = (input?: ScopedCollectionReadOptions) => ({
              ...input,
              signal: readOptions?.signal && input?.signal
                ? AbortSignal.any([readOptions.signal, input.signal])
                : readOptions?.signal ?? input?.signal,
            });
            const read = {
              get: (
                name: string,
                id: string,
                options?: ScopedCollectionReadOptions,
              ) => target(name).get(scope, { id }, controls(options)),
              list: (
                name: string,
                query?: CollectionQuery,
                options?: ScopedCollectionReadOptions,
              ) => target(name).list(scope, query, controls(options)),
              aggregate: (
                name: string,
                query: CollectionAggregateQuery,
                options?: Pick<ScopedCollectionReadOptions, "signal">,
              ) => target(name).aggregate(scope, query, controls(options)),
            } as const;
            output = await spec.select({
              input: queryInput,
              read,
            }) as readonly TSelect[];
          } else if (spec.query) {
            output = await list(namespace, spec.query({ input: queryInput }));
          } else {
            output = await list(namespace, {
              where: spec.filter?.({ input: queryInput }),
            });
          }
          if (spec.outputSchema) {
            validateAgainstJsonSchema(
              spec.outputSchema,
              output,
              `${name}.${queryName} output`,
            );
          }
          return output;
        },
      ]),
    );

    const query = Object.assign(list, namedQueries) as BoundCollectionQuery<
      TSelect
    >;

    const collection = ({
      definition,
      create,
      update,
      delete: remove,
      mutate,
      get: read,
      list,
      aggregate,
      query,
      search: (namespace: string, queryInput: CollectionQuery) =>
        list(namespace, { ...queryInput, text: queryInput.text ?? "" }),
      ...namedQueries,
    } as const) as BoundCollection<TSelect, TInsert>;
    transactionBindings.set(
      name,
      {
        definition,
        async create(input, writeOptions, order) {
          const id = requireText(String(input.id), `${name} id`);
          const intent: CollectionMutationIntent = {
            operation: "create",
            input: await canonicalIntent(input),
          } as const;
          return stageOperation(
            await replayOperation(
              `${name}.created`,
              id,
              "create",
              writeOptions,
              intent,
            ) ?? await planCreate(input as TInsert, writeOptions, intent),
            order,
          );
        },
        async update(id, patch, writeOptions, order) {
          const intent: CollectionMutationIntent = {
            operation: "update",
            id,
            set: await canonicalIntent(patch.set ?? {}),
            unset: [...(patch.unset ?? [])] as const,
          } as const;
          return stageOperation(
            await replayOperation(
              `${name}.updated`,
              id,
              "update",
              writeOptions,
              intent,
            ) ?? await planUpdate(
              id,
              patch as CollectionUpdatePatch<TSelect>,
              writeOptions,
              intent,
              true,
            ),
            order,
          );
        },
        async delete(id, writeOptions, order) {
          const intent: CollectionMutationIntent = {
            operation: "delete",
            id,
          } as const;
          return stageOperation(
            await replayOperation(
              `${name}.deleted`,
              id,
              "delete",
              writeOptions,
              intent,
            ) ?? await planRemove(id, writeOptions, intent),
            order,
          );
        },
        async mutate(id, command, input, writeOptions, order) {
          const commandDefinition = definition.commands?.[command];
          if (!commandDefinition) {
            throw new Error(`Unknown ${name} command '${command}'.`);
          }
          if (
            commandDefinition.input &&
            typeof commandDefinition.input === "object"
          ) {
            validateCollectionRecord(
              commandDefinition.input,
              asRecord(input),
              `${name}.${command} input`,
            );
          }
          const intent: CollectionMutationIntent = {
            operation: "command",
            id,
            name: command,
            input: await canonicalIntent(input),
          } as const;
          const eventType = commandDefinition.event ?? `${name}.updated`;
          return stageOperation(
            await replayOperation(
              eventType,
              id,
              `mutate:${command}`,
              writeOptions,
              intent,
            ) ?? await planMutate(
              id,
              command,
              input,
              writeOptions,
              intent,
              true,
            ),
            order,
          );
        },
      } as const,
    );
    bound.set(definition.name, collection as BoundCollection);
    operations.set(
      name,
      createCollectionOperations(collection as BoundCollection, {
        activeTransaction: () => Boolean(activeScope()),
        activeSnapshot: () => Boolean(activeSnapshot()),
        contentResolver: options.contentResolver,
        relations: (namespace, query) =>
          queryCollectionRelations(executor(), tables, namespace, name, query),
      }),
    );
    return collection;
  };

  const transaction = async <T>(
    input: CollectionTransactionOptions<T>,
  ): Promise<CollectionTransactionResult<T>> => {
    if (activeSnapshot()) {
      throw new Error(
        "Collection transactions are not allowed inside a read snapshot.",
      );
    }
    const execute = input.execute;
    const transactionIdentity = input.identity
      ? (structuredClone(input.identity))
      : undefined;
    if (transactionIdentity?.metadata) {
      assertLosslessJson(
        transactionIdentity.metadata,
        "Collection transaction metadata",
      );
    }
    const parent = activeScope();
    if (parent) {
      throw new Error(
        "Nested Collection transactions are not supported; reuse the active transaction context.",
      );
    }
    const operationKey = requireText(input.operationKey, "Operation key");
    const namespace = requireText(input.namespace, "Namespace");
    const operationPath = [operationKey] as const;
    const orderPath: readonly number[] = [] as const;
    const settlementScopeId = transactionIdentity?.settlementScopeId?.trim() ||
      await deriveWorkflowId(
        "scope",
        JSON.stringify([namespace, operationPath]),
      );
    const correlationId = transactionIdentity?.correlationId?.trim() ||
      settlementScopeId;
    const scope: TransactionScope = {
      operationKey,
      rootIdentity: transactionIdentity?.deduplicationId?.trim() ||
        operationKey,
      namespace,
      settlementScopeId,
      correlationId,
      causationId: transactionIdentity?.causationId,
      metadata: structuredClone(transactionIdentity?.metadata ?? {}),
      operationPath,
      orderPath,
      identityOccurrences: new Map(),
      orderSequence: 0,
      planning: [],
      planningQueues: new Map(),
      state: "open",
      plans: [],
      records: new Map(),
      assets: new Map(),
      assetKeys: new Map(),
      relations: new Map(),
      invalidatedRelationEndpoints: new Set(),
    };

    const callIdentity = (
      target: string,
      occurrence: number,
      inputOptions: ScopedCollectionCallOptions | undefined,
    ): readonly unknown[] => {
      const explicitDeduplicationId = inputOptions?.identity
        ?.deduplicationId?.trim();
      if (explicitDeduplicationId) {
        return (["deduplication", explicitDeduplicationId] as const);
      }
      const explicitKey = inputOptions?.operationKey?.trim();
      return explicitKey ? (["key", operationPath, explicitKey] as const) : ([
        "target",
        operationPath,
        target,
        occurrence,
      ] as const);
    };

    const implicitId = async (
      kind: "record" | "relation",
      collection: string,
      target: string,
      occurrence: number,
      inputOptions: ScopedCollectionCallOptions | undefined,
    ): Promise<string> =>
      await deriveWorkflowId(
        kind,
        JSON.stringify([
          namespace,
          scope.rootIdentity,
          collection,
          callIdentity(target, occurrence, inputOptions),
        ]),
      );

    const callOptions = async (
      collection: string,
      operation: string,
      id: string,
      target: string,
      occurrence: number,
      inputOptions: ScopedCollectionCallOptions | undefined,
    ): Promise<CollectionWriteOptions> => {
      const { operationKey: _operationKey, identity, ...rest } = inputOptions ??
        {};
      if (identity?.metadata) {
        assertLosslessJson(identity.metadata, "Collection mutation metadata");
      }
      if (rest.metadata) {
        assertLosslessJson(rest.metadata, "Collection mutation metadata");
      }
      const deduplicationId = identity?.deduplicationId ??
        await deriveWorkflowId(
          "mutation",
          JSON.stringify([
            scope.rootIdentity,
            callIdentity(target, occurrence, inputOptions),
            collection,
            operation,
            id,
          ]),
        );
      return ({
        namespace,
        ...structuredClone(rest),
        identity: {
          causationId: identity?.causationId ?? scope.causationId,
          correlationId: identity?.correlationId ?? scope.correlationId,
          settlementScopeId: identity?.settlementScopeId ??
            scope.settlementScopeId,
          deduplicationId,
          metadata: structuredClone({
            ...scope.metadata,
            ...identity?.metadata,
          }),
        },
      });
    };

    const allocateOrder = (): readonly number[] => {
      if (scope.state !== "open") {
        throw new Error("Transaction mutation planning is already closed.");
      }
      return ([
        ...scope.orderPath,
        ++scope.orderSequence,
      ] as const);
    };

    const allocateIdentity = (target: string): number => {
      const occurrence = (scope.identityOccurrences.get(target) ?? 0) + 1;
      scope.identityOccurrences.set(target, occurrence);
      return occurrence;
    };

    const registerMutation = <T>(
      order: readonly number[],
      register: () => Readonly<{
        key: string;
        operation: () => Promise<T>;
      }>,
    ): Promise<T> => {
      try {
        const mutation = register();
        return beginPlanning(scope, mutation.key, mutation.operation);
      } catch (error) {
        return beginPlanning(
          scope,
          JSON.stringify(["invalid-mutation", order]),
          () => Promise.reject(error),
        );
      }
    };

    const collections = (Object.fromEntries(
      [...transactionBindings].map(([name, binding]) => {
        const planningKey = (id: string): string =>
          binding.definition.content?.fields.length
            ? JSON.stringify(["content"])
            : JSON.stringify(["record", name, id]);
        const commands = Object.fromEntries(
          Object.keys(binding.definition.commands ?? {}).map((command) => [
            command,
            (
              commandInput: Readonly<
                Record<string, unknown> & { id: string }
              >,
              commandOptions?: ScopedCollectionCallOptions,
            ) => {
              const order = allocateOrder();
              return registerMutation(order, () => {
                const commandSnapshot = structuredClone(commandInput);
                const optionsSnapshot = commandOptions
                  ? (structuredClone(commandOptions))
                  : undefined;
                const id = requireText(commandSnapshot.id, `${name} id`);
                const { id: _id, ...value } = commandSnapshot;
                return {
                  key: planningKey(id),
                  operation: async () => {
                    const canonicalInput = await canonicalIntentValue(
                      value,
                      new Set(
                        (binding.definition.content?.fields ?? []).map((
                          field,
                        ) => JSON.stringify(field.split(".").filter(Boolean))),
                      ),
                    );
                    const target = JSON.stringify([
                      "record",
                      name,
                      `command:${command}`,
                      id,
                      canonicalInput,
                    ]);
                    const occurrence = allocateIdentity(target);
                    return await binding.mutate(
                      id,
                      command,
                      value,
                      await callOptions(
                        name,
                        `command:${command}`,
                        id,
                        target,
                        occurrence,
                        optionsSnapshot,
                      ),
                      order,
                    );
                  },
                };
              });
            },
          ]),
        );
        const collection: TransactionCollection = {
          create: (value, createOptions) => {
            const order = allocateOrder();
            return registerMutation(order, () => {
              const valueSnapshot = structuredClone(value);
              const optionsSnapshot = createOptions
                ? (structuredClone(createOptions))
                : undefined;
              const rawId = (valueSnapshot as Record<string, unknown>).id;
              const explicitId = typeof rawId === "string" && rawId.trim()
                ? rawId.trim()
                : undefined;
              return {
                key: explicitId
                  ? planningKey(explicitId)
                  : binding.definition.content?.fields.length
                  ? JSON.stringify(["content"])
                  : JSON.stringify(["implicit-record", name]),
                operation: async () => {
                  const canonicalInput = await canonicalIntentValue(
                    valueSnapshot,
                    new Set(
                      (binding.definition.content?.fields ?? []).map((field) =>
                        JSON.stringify(field.split(".").filter(Boolean))
                      ),
                    ),
                  );
                  const target = JSON.stringify(
                    explicitId
                      ? ["record", name, "create", explicitId, canonicalInput]
                      : ["implicit-record", name, canonicalInput],
                  );
                  const occurrence = allocateIdentity(target);
                  const id = explicitId ?? await implicitId(
                    "record",
                    name,
                    target,
                    occurrence,
                    optionsSnapshot,
                  );
                  return await binding.create(
                    { ...valueSnapshot as Record<string, unknown>, id },
                    await callOptions(
                      name,
                      "create",
                      id,
                      target,
                      occurrence,
                      optionsSnapshot,
                    ),
                    order,
                  );
                },
              };
            });
          },
          update: (value, updateOptions) => {
            const order = allocateOrder();
            return registerMutation(order, () => {
              const valueSnapshot = structuredClone(value);
              const optionsSnapshot = updateOptions
                ? (structuredClone(updateOptions))
                : undefined;
              const id = requireText(valueSnapshot.id, `${name} id`);
              return {
                key: planningKey(id),
                operation: async () => {
                  const contentPaths = new Set(
                    (binding.definition.content?.fields ?? []).map((field) =>
                      JSON.stringify(field.split(".").filter(Boolean))
                    ),
                  );
                  const target = JSON.stringify([
                    "record",
                    name,
                    "update",
                    id,
                    await canonicalIntentValue(
                      valueSnapshot.set ?? {},
                      contentPaths,
                    ),
                    [...(valueSnapshot.unset ?? [])],
                  ]);
                  const occurrence = allocateIdentity(target);
                  return await binding.update(
                    id,
                    { set: valueSnapshot.set, unset: valueSnapshot.unset },
                    await callOptions(
                      name,
                      "update",
                      id,
                      target,
                      occurrence,
                      optionsSnapshot,
                    ),
                    order,
                  );
                },
              };
            });
          },
          delete: (value, deleteOptions) => {
            const order = allocateOrder();
            return registerMutation(order, () => {
              const valueSnapshot = structuredClone(value);
              const optionsSnapshot = deleteOptions
                ? (structuredClone(deleteOptions))
                : undefined;
              const id = requireText(valueSnapshot.id, `${name} id`);
              const target = JSON.stringify(["record", name, "delete", id]);
              const occurrence = allocateIdentity(target);
              return {
                key: planningKey(id),
                operation: async () =>
                  await binding.delete(
                    id,
                    await callOptions(
                      name,
                      "delete",
                      id,
                      target,
                      occurrence,
                      optionsSnapshot,
                    ),
                    order,
                  ),
              };
            });
          },
          commands,
        } as const;
        return [name, collection];
      }),
    )) as CollectionTransactionCollections;

    const relations: CollectionTransactionRelations = {
      upsert(relationInput, relationOptions) {
        const order = allocateOrder();
        return registerMutation(order, () => {
          const relationSnapshot = structuredClone(relationInput);
          assertLosslessJson(relationSnapshot, "Relation mutation input");
          const optionsSnapshot = relationOptions
            ? (structuredClone(relationOptions))
            : undefined;
          const explicitId = typeof relationSnapshot.id === "string" &&
              relationSnapshot.id.trim()
            ? relationSnapshot.id.trim()
            : undefined;
          const key = explicitId
            ? JSON.stringify(["relation", explicitId])
            : JSON.stringify(["implicit-relation"]);
          return {
            key,
            operation: async () => {
              const canonicalInput = await canonicalIntentValue(
                relationSnapshot,
              );
              const target = JSON.stringify(
                explicitId
                  ? ["relation", "upsert", explicitId, canonicalInput]
                  : ["implicit-relation", canonicalInput],
              );
              const occurrence = allocateIdentity(target);
              const relationId = explicitId ?? await implicitId(
                "relation",
                "relation",
                target,
                occurrence,
                optionsSnapshot,
              );
              const normalized = normalizeGraphRelation(
                namespace,
                { ...relationSnapshot, id: relationId },
                now().toISOString(),
              );
              const intent: GraphRelationIntent = {
                id: normalized.id,
                type: normalized.type,
                source: structuredClone(normalized.source),
                target: structuredClone(normalized.target),
                metadata: structuredClone(normalized.metadata),
                weight: normalized.weight,
              };
              const writeOptions = await callOptions(
                "relation",
                "upsert",
                relationId,
                target,
                occurrence,
                optionsSnapshot,
              );
              const identity = writeOptions.identity!;
              const deduplicationId = identity.deduplicationId!;
              const bodyId = `event-body:${namespace}:${deduplicationId}`;
              const replay = await options.eventStore.getEventByDeduplicationId(
                namespace,
                deduplicationId,
              );
              let expected: CollectionGraphRelation | null | undefined;
              let body: GraphRelationEventBody;
              if (replay) {
                if (
                  replay.type !== "relation.upserted" ||
                  replay.subject?.type !== "relation" ||
                  replay.subject.id !== relationId
                ) {
                  throw new Error(
                    `Relation transaction identity '${deduplicationId}' was reused by another mutation.`,
                  );
                }
                body = await readEventBody<GraphRelationEventBody>(
                  { transaction: options.session, tables },
                  namespace,
                  eventDataRef(replay.payload),
                );
                if (!sameValue(body.intent, intent)) {
                  throw new Error(
                    `Relation transaction identity '${deduplicationId}' was reused with another intent.`,
                  );
                }
              } else {
                for (const endpoint of [normalized.source, normalized.target]) {
                  const stateKey = `${endpoint.type}\u0000${endpoint.id}`;
                  if (
                    scope.records.has(stateKey) && !scope.records.get(stateKey)
                  ) {
                    throw new Error(
                      `Relation ${endpoint.type} '${endpoint.id}' was deleted in this transaction.`,
                    );
                  }
                }
                const endpointWasInvalidated = [
                  normalized.source,
                  normalized.target,
                ].some((endpoint) =>
                  scope.invalidatedRelationEndpoints.has(
                    `${endpoint.type}\u0000${endpoint.id}`,
                  )
                );
                const existing = scope.relations.has(relationId)
                  ? scope.relations.get(relationId)!
                  : endpointWasInvalidated
                  ? null
                  : await loadGraphRelation(
                    options.session,
                    tables,
                    namespace,
                    relationId,
                  );
                expected = existing;
                const relation = mergeGraphRelation(
                  existing,
                  {
                    ...normalized,
                    ...(existing ? { createdAt: existing.createdAt } : {}),
                  } as const,
                );
                body = {
                  operation: "upsert" as const,
                  intent,
                  relation,
                };
              }
              assertJsonValue(body, {
                label: "relation.upserted Event Body",
                rejectNegativeZero: true,
              });
              scope.relations.set(relationId, body.relation);
              scope.plans.push(
                {
                  id: relationId,
                  order: [...order] as const,
                  async commit(transaction, pending) {
                    const result = await options.coordinator.commitMutation({
                      draft: {
                        type: "relation.upserted",
                        namespace,
                        subject: { type: "relation", id: relationId },
                        payload: {
                          dataRef: {
                            eventBodyId: bodyId,
                            schemaVersion: 1,
                            mediaType: "application/json",
                          },
                        },
                        metadata: structuredClone({
                          ...identity.metadata,
                          ...writeOptions.metadata,
                        }),
                        causationId: identity.causationId,
                        correlationId: identity.correlationId,
                        deduplicationId,
                        settlementScopeId: identity.settlementScopeId,
                      },
                      transaction,
                      dispatch: false,
                      matchData: body,
                      mutate: async (context) => {
                        if (expected !== undefined) {
                          const current = await loadGraphRelation(
                            context.transaction,
                            context.tables,
                            namespace,
                            relationId,
                            true,
                          );
                          if (!sameValue(current, expected)) {
                            throw new Error(
                              `Relation '${relationId}' changed while its mutation was prepared.`,
                            );
                          }
                        }
                        await writeEventBody(context, {
                          namespace,
                          id: bodyId,
                          json: body,
                        });
                        return await projectGraphRelation(
                          context,
                          body.relation,
                        );
                      },
                      recoverDuplicate: async (event, context) => {
                        const existing = await readEventBody<
                          GraphRelationEventBody
                        >(
                          context,
                          namespace,
                          eventDataRef(event.payload),
                        );
                        if (!sameValue(existing.intent, body.intent)) {
                          throw new Error(
                            "Deduplicated relation event was reused with another intent.",
                          );
                        }
                        return existing.relation;
                      },
                    });
                    pending.push(result as CoordinatedMutationResult<unknown>);
                    return undefined;
                  },
                } as const,
              );
              return ({ id: relationId } as const);
            },
          };
        });
      },
    } as const;

    const vectors: VectorTransaction = {
      upsert(input) {
        const order = allocateOrder();
        return registerMutation(order, () => {
          validateVector(input.profile, input.values);
          const body = structuredClone(input);
          const target = JSON.stringify([
            "vector",
            body.ownerType,
            body.ownerId,
            body.field,
            vectorProfileKey(body.profile),
          ]);
          const occurrence = allocateIdentity(target);
          return {
            key: target,
            operation: async () => {
              const id = await deriveWorkflowId(
                "vector",
                JSON.stringify([
                  namespace,
                  body.ownerType,
                  body.ownerId,
                  body.field,
                  vectorProfileKey(body.profile),
                ]),
              );
              const identity = (await callOptions(
                "vector",
                "upsert",
                id,
                target,
                occurrence,
                undefined,
              )).identity!;
              const bodyId =
                `event-body:${namespace}:${identity.deduplicationId}`;
              scope.plans.push({
                id,
                order,
                async commit(transaction, pending) {
                  const result = await options.coordinator.commitMutation({
                    draft: {
                      type: "vector.upserted",
                      namespace,
                      subject: { type: "vector", id },
                      payload: {
                        dataRef: {
                          eventBodyId: bodyId,
                          schemaVersion: 1,
                          mediaType: "application/json",
                        },
                      },
                      ...identity,
                    },
                    transaction,
                    dispatch: false,
                    async mutate(context) {
                      await writeEventBody(context, {
                        namespace,
                        id: bodyId,
                        json: body,
                      });
                      await projectVector(
                        transaction,
                        options.eventStore.databaseSchema,
                        namespace,
                        body,
                      );
                    },
                    async recoverDuplicate(event, context) {
                      const previous = await readEventBody<VectorWrite>(
                        context,
                        namespace,
                        eventDataRef(event.payload),
                      );
                      if (!sameValue(previous, body)) {
                        throw new Error(
                          "Vector transaction identity was reused with another vector.",
                        );
                      }
                    },
                  });
                  pending.push(result);
                },
              });
            },
          };
        });
      },
    };
    const run = () => execute({ collections, relations, vectors });

    const value = await finishPlanning(scope, run);
    const pending: CoordinatedMutationResult<unknown>[] = [];
    const writes: CollectionWrite<CollectionRecord>[] = [];
    const orderedPlans = [...scope.plans].sort(comparePlanOrder);
    const assertProtection = (plan: PlannedTransactionMutation): void => {
      if (
        plan.protectionDeadline !== undefined &&
        plan.protectionDeadline <= Date.now()
      ) {
        throw new Error(
          `Prepared content protection expired before graph mutation '${plan.id}' could commit.`,
        );
      }
    };
    for (const plan of orderedPlans) assertProtection(plan);
    try {
      await options.session.transaction(async (transaction) => {
        const replacements = options.assets
          ? await options.assets.reconcileMaterializations(transaction, [
            ...new Set([...scope.assets.values()].map((asset) => asset.plan)),
          ])
          : new Map<string, AssetManifestEntry>();
        for (const plan of orderedPlans) {
          assertProtection(plan);
          const write = await plan.commit(transaction, pending, replacements);
          if (write) writes.push(write);
        }
      });
    } catch (error) {
      throw error;
    }

    const reports: EventDispatchReport[] = [];
    for (const committed of pending) {
      reports.push(await options.coordinator.flushCommitted(committed));
    }
    return ({
      value,
      operationKey,
      namespace,
      settlementScopeId,
      correlationId,
      writes: writes.slice(),
      dispatch: {
        handles: reports.flatMap((item) => [...item.handles]),
        failures: reports.flatMap((item) => [...item.failures]),
      } as const,
    } as const);
  };

  const withScope = (scope: CollectionScope): ScopedCollections => {
    requireText(scope.namespace, "Namespace");
    return (Object.fromEntries(
      [...operations].map((
        [name, collection],
      ) => [name, bindCollectionScope(collection, scope)]),
    ));
  };

  const readSnapshot = async <T>(
    scope: Pick<CollectionScope, "namespace">,
    execute: (
      context: Readonly<{ collections: SnapshotCollections }>,
    ) => T | Promise<T>,
  ): Promise<T> => {
    if (activeSnapshot()) {
      throw new Error("Nested read snapshots are not supported.");
    }
    if (!options.session.readSnapshot) {
      throw new Error(
        "The configured SQL session does not support repeatable read snapshots.",
      );
    }
    return await options.session.readSnapshot(async (executor) => {
      const snapshot: SnapshotScope = { executor, state: "open" };
      return await snapshots.run(snapshot, async () => {
        const closed = () =>
          Promise.reject(
            new Error("Read snapshot access has already closed."),
          );
        const scoped = withScope({ namespace: scope.namespace });
        const collections = (Object.fromEntries(
          Object.entries(scoped).map((
            [name, collection],
          ) => [
            name,
            {
              definition: collection.definition,
              get: (...args: unknown[]) => {
                if (snapshot.state !== "open") return closed();
                return (collection.get as (...input: unknown[]) => unknown)(
                  ...args,
                );
              },
              list: (...args: unknown[]) => {
                if (snapshot.state !== "open") return closed();
                return (collection.list as (...input: unknown[]) => unknown)(
                  ...args,
                );
              },
              aggregate: (...args: unknown[]) => {
                if (snapshot.state !== "open") return closed();
                return (collection.aggregate as (
                  ...input: unknown[]
                ) => unknown)(...args);
              },
              search: (...args: unknown[]) => {
                if (snapshot.state !== "open") return closed();
                return (collection.search as (...input: unknown[]) => unknown)(
                  ...args,
                );
              },
              queries: Object.fromEntries(
                Object.entries(collection.queries).map((
                  [query, call],
                ) => [query, (...args: unknown[]) => {
                  if (snapshot.state !== "open") return closed();
                  return (call as (...input: unknown[]) => unknown)(...args);
                }]),
              ),
              relations: {
                list: (...args: unknown[]) => {
                  if (snapshot.state !== "open") return closed();
                  return (collection.relations.list as (
                    ...input: unknown[]
                  ) => unknown)(...args);
                },
              } as const,
            } as const,
          ]),
        )) as unknown as SnapshotCollections;
        try {
          return await execute({ collections } as const);
        } finally {
          snapshot.state = "closed";
        }
      });
    });
  };

  const runtime: CollectionKernel = {
    vectors: (namespace: string) => ({
      search: (input) =>
        searchVectors(
          options.session,
          options.eventStore.databaseSchema,
          namespace,
          input,
        ),
    }),
    bind,
    get: <
      TSelect extends CollectionRecord = CollectionRecord,
      TInsert extends object = Record<string, unknown>,
    >(name: string) =>
      bound.get(name) as BoundCollection<TSelect, TInsert> | undefined,
    operations: (name: string) => operations.get(name),
    transaction,
    withScope,
    readSnapshot,
    verify: (definition, namespace) =>
      options.session.transaction(async (transaction) => {
        await transaction.query(
          `LOCK TABLE ${tables.nodes}, ${tables.edges} IN SHARE MODE`,
        );
        return await verifyCollectionProjections(
          transaction,
          options.eventStore,
          definition,
          namespace,
        );
      }),
    async rebuild(namespace) {
      await options.session.transaction((transaction) =>
        rebuildNamespaceProjections(
          transaction,
          options.eventStore,
          [...bound.values()].map((collection) => collection.definition),
          requireText(namespace, "Namespace"),
          options.runtimeProjections,
        )
      );
    },
  } as const;
  return runtime;
}

export async function resolveCollectionEventBody<
  TRecord = CollectionRecord,
>(
  session: SqlExecutor,
  store: EventStore,
  event: CollectionDurableEvent,
): Promise<CollectionEventBody<TRecord>> {
  return await readEventBody<CollectionEventBody<TRecord>>(
    { transaction: session, tables: store.tables },
    event.namespace,
    event.dataRef,
  );
}

/** Public Collections use one explicit-context implementation; kernel reports stay internal. */
export type CollectionRuntime =
  & Omit<CollectionKernel, "bind" | "get" | "operations">
  & {
    bind<
      TSelect extends CollectionRecord = CollectionRecord,
      TInsert extends object = Record<string, unknown>,
    >(definition: CollectionDefinition): CollectionOperations<TSelect, TInsert>;
    get<
      TSelect extends CollectionRecord = CollectionRecord,
      TInsert extends object = Record<string, unknown>,
    >(name: string): CollectionOperations<TSelect, TInsert> | undefined;
  };
export function createCollectionRuntime(
  options: CreateCollectionRuntimeOptions,
): CollectionRuntime {
  const kernel = createCollectionKernel(options);
  return ({
    bind(definition: CollectionDefinition) {
      kernel.bind(definition);
      return kernel.operations(definition.name)!;
    },
    get: (name: string) => kernel.operations(name),
    vectors: kernel.vectors,
    withScope: kernel.withScope,
    readSnapshot: kernel.readSnapshot,
    transaction: kernel.transaction,
    verify: kernel.verify,
    rebuild: kernel.rebuild,
  } as const) as CollectionRuntime;
}
