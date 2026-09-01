import type {
  AuthorizeContent,
  BodyStorageOptions,
  BodyStorageRuntime,
  BodyStore,
  ContentPreparer,
  ContentResolver,
  DatabaseAssetRepository,
  PublishAssetInput,
  ReadBodyRangeInput,
} from "../content/index.ts";
import type {
  CoordinatedMutationResult,
  CopilotzEvent,
  CopilotzEventFilter,
  CopilotzEventHub,
  DeliveryScopeSettlement,
  DurableEvent,
  DurableEventDraft,
  EphemeralEvent,
  EphemeralEventDraft,
  EventDelivery,
  EventDispatchReport,
  SqlSession,
} from "../events/index.ts";
import type {
  ApplicationOutputDescriptor,
  RuntimeOutputDescriptor,
  StreamOutput,
} from "../streams/index.ts";
import type {
  CreateDeliveryExecutorOptions,
  DeliveryExecutorOwnership,
  DeliveryRecoveryDispatch,
  DeliveryWorkload,
  ExecutionWorkHandle,
  ExecutionWorkInput,
} from "../execution/index.ts";
import type {
  CollectionMutationIdentity,
  CollectionRuntime,
} from "../collections/index.ts";
import type {
  AnyProcessor,
  PluginRegistry,
  Processor,
  ProcessorEvent,
} from "../plugins/index.ts";
import type { ProgressiveBodyMaintenanceResult } from "../content/index.ts";
import type { ContentStreamFollowInput } from "../streams/index.ts";
import type { ActionLifecycleEmitter } from "../actions/index.ts";
import type { SecretAdapter } from "../actions/secret-adapter.ts";
import type { ActionEventData, ActionSchema } from "../actions/types.ts";
import type { ProtectedEventResolver } from "../actions/protected-context.ts";
import type { OperationCatalog } from "../streams/catalog.ts";

export type EphemeralEventInput = EphemeralEventDraft;
export type RuntimeOutputPublisher = (
  output: ApplicationOutputDescriptor,
  context?: Readonly<{ databaseSchema: string; settlementScopeId?: string }>,
) => void | Promise<void>;
export type EngineMutationIdentityFactory = (
  operationKey: string,
  metadata?: Record<string, unknown>,
) => CollectionMutationIdentity;

export type EngineContextSource = Readonly<{
  kind: "delivery" | "stream" | "live";
  id: string;
  consumerId?: string;
}>;

/** Private executor input used to construct one runtime-neutral context. */
export type EngineContextSeed = Readonly<{
  databaseSchema: string;
  event: CopilotzEvent;
  signal: AbortSignal;
  /** Unique dispatcher execution attempt; never exposed on ProcessorContext. */
  executionIncarnationId?: string;
  settlementScopeId?: string;
  idempotencyKey: string;
  createMutationIdentity: EngineMutationIdentityFactory;
  source?: EngineContextSource;
}>;

export type CopilotzEngineExecutionOptions = Omit<
  CreateDeliveryExecutorOptions,
  | "store"
  | "resolveStore"
  | "defaultDatabaseSchema"
  | "registry"
  | "createContext"
>;

export type CreateCopilotzEngineOptions = Readonly<{
  session: SqlSession;
  registry: PluginRegistry;
  defaultDatabaseSchema?: string;
  /** Provision the default schema during engine startup. Set false to validate it only. */
  provisionDefaultDatabaseSchema?: boolean;
  execution?: CopilotzEngineExecutionOptions;
  eventHub?: CopilotzEventHub;
  publish?: RuntimeOutputPublisher;
  /** Process-local authority for unscoped application-visible stream output. */
  publishLocalStream?: (
    output: StreamOutput,
    context: Readonly<{ databaseSchema: string }>,
  ) => void | Promise<void>;
  onDispatchFailure?: (failure: {
    deliveryId: string;
    error: unknown;
  }) => void;
  authorizeContent?: AuthorizeContent;
  createId?: () => string;
  now?: () => Date;
  random?: () => number;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
  assets?: BodyStorageOptions;
  /** Compiled once by the engine so memory/custom stores span database scopes. */
  assetStorage?: BodyStorageRuntime;
  /** Runtime-validated local protection boundary. */
  secretAdapter?: SecretAdapter;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  /** Connection-bound processors. Same contract as static, no delivery rows. */
  transientProcessors?: readonly AnyProcessor[];
}>;

export type CopilotzEngineMaintenanceResult = Readonly<{
  recovered: number;
  dispatchFailures: number;
  compacted: Readonly<{ deliveries: number }>;
  progressiveBodies: ProgressiveBodyMaintenanceResult;
  assets: Readonly<{
    orphanedBodiesDeleted: number;
  }>;
  operations: Readonly<{
    reconciled: number;
    reconciledStreams: number;
    expiredObservationStreams: number;
    observationRetirementBlocked: number;
    prunedCatalogEntries: number;
    prunedTerminalStreams: number;
    prunedOperationEvents: number;
    prunedOperations: number;
  }>;
}>;

export type CopilotzEngineDatabaseScope = Readonly<{
  databaseSchema: string;
  content: Readonly<{
    assets: DatabaseAssetRepository;
    preparer: ContentPreparer;
    resolver: ContentResolver;
  }>;
  collections: CollectionRuntime;
  streams: Readonly<{
    follow(
      namespace: string,
      input: ContentStreamFollowInput,
    ): Promise<ReadableStream<Uint8Array>>;
    /** Finite reconnect read bounded by the durable operation catalog. */
    readCommittedRange(input: ReadBodyRangeInput): Promise<Uint8Array | null>;
  }>;
  /** Internal durable operational metadata. Contains no progressive bytes. */
  operations: OperationCatalog;
  events: CopilotzEngine["events"];
  deliveries: CopilotzEngine["deliveries"];
  recover(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
  maintenance(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
    retentionMs?: number | null;
    now?: Date;
    assetOrphanAfterMs?: number;
    operationObservationLimit?: number;
    operationRetentionMs?: number | null;
  }): Promise<CopilotzEngineMaintenanceResult>;
}>;

export type CopilotzEngine = Readonly<{
  databaseSchema: string;
  operations: OperationCatalog;
  databaseScope(databaseSchema: string): Promise<CopilotzEngineDatabaseScope>;
  plugins: PluginRegistry;
  execution: Readonly<{
    ownership: DeliveryExecutorOwnership;
    workload: string;
    liveWorkload: string;
    /** Register these closures in a worker created within this runtime. */
    workloads: Readonly<Record<string, DeliveryWorkload>>;
    dispatchWork(input: ExecutionWorkInput): Promise<ExecutionWorkHandle>;
    /** Waits until output already relayed for one durable causal scope settles. */
    settleOutputs(scope: {
      databaseSchema?: string;
      namespace: string;
      settlementScopeId: string;
    }): Promise<void>;
  }>;
  content: Readonly<{
    assets: DatabaseAssetRepository;
    preparer: ContentPreparer;
    resolver: ContentResolver;
  }>;
  collections: CollectionRuntime;
  streams: CopilotzEngineDatabaseScope["streams"];
  events: Readonly<{
    append(
      draft: DurableEventDraft,
      options?: { priority?: number; maxAttempts?: number },
    ): Promise<CoordinatedMutationResult<void>>;
    /** Internal bridge ingress that seals schema-marked values before commit. */
    appendProtected(
      draft: DurableEventDraft,
      schema: ActionSchema,
      ownerId: string,
    ): Promise<CoordinatedMutationResult<void>>;
    emit(input: EphemeralEventInput): Promise<EphemeralEvent>;
    subscribe(filter?: CopilotzEventFilter): ReadableStream<CopilotzEvent>;
    waitFor(
      filter: CopilotzEventFilter & {
        namespace: string;
        timeoutMs?: number;
        pollIntervalMs?: number;
      },
      signal?: AbortSignal,
    ): Promise<CopilotzEvent>;
    get(namespace: string, id: string): Promise<DurableEvent | null>;
    /** Resolves one durable Event's integrity-checked body for internal consumers. */
    resolve(namespace: string, id: string): Promise<ProcessorEvent | null>;
    /** Internal trusted hydration for one explicitly authorized bridge Event. */
    resolveProtected(
      namespace: string,
      id: string,
      schema: ActionSchema,
    ): Promise<ProcessorEvent | null>;
    /** Internal trusted hydration for one registered Action lifecycle Event. */
    resolveActionLifecycle(
      namespace: string,
      id: string,
    ): Promise<ActionEventData | null>;
    list(options: {
      namespace: string;
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      order?: "asc" | "desc";
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
    settlement(
      namespace: string,
      settlementScopeId: string,
    ): Promise<DeliveryScopeSettlement>;
    cancel(
      namespace: string,
      settlementScopeId: string,
      reason?: string,
    ): Promise<number>;
  }>;
  deliveries: Readonly<{
    get(namespace: string, id: string): Promise<EventDelivery | null>;
    list(options: {
      namespace: string;
      eventId?: string;
      consumerId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
    retry(namespace: string, id: string): Promise<boolean>;
    discard(namespace: string, id: string): Promise<boolean>;
  }>;
  recover(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
  /** Recovers durable work from every database scope opened by this engine. */
  recoverAll(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
  maintenance(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
    retentionMs?: number | null;
    now?: Date;
    assetOrphanAfterMs?: number;
    operationObservationLimit?: number;
  }): Promise<CopilotzEngineMaintenanceResult>;
  shutdown(reason?: string): Promise<void>;
  bindTransient(
    processor: Processor,
    options?: Readonly<{
      namespace?: string;
      afterPosition?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<() => void>;
}>;

export type CreateProcessorContextOptions = Readonly<{
  base: EngineContextSeed;
  registry: PluginRegistry;
  assets: DatabaseAssetRepository;
  preparer: ContentPreparer;
  resolver: ContentResolver;
  collections: CollectionRuntime;
  eventHub: CopilotzEventHub;
  publishOutput?: (output: RuntimeOutputDescriptor) => Promise<void>;
  publishLocalStream?: (output: StreamOutput) => Promise<void>;
  actionLifecycle: ActionLifecycleEmitter;
  now?: () => Date;
  streamBodyStore: BodyStore;
  streamBodyPrefix: string;
  operationCatalog: OperationCatalog;
  protectedEventResolver?: ProtectedEventResolver;
}>;

export type CopilotzEngineDispatchReport = EventDispatchReport;
export type CopilotzEnginePublishAssetInput = Omit<
  PublishAssetInput,
  "namespace"
>;
