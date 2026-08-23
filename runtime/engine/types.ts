import type {
  AuthorizeContent,
  BodyStorageOptions,
  BodyStorageRuntime,
  BodyStore,
  ContentPreparer,
  ContentResolver,
  DatabaseAssetRepository,
  PublishAssetInput,
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
  EventPublisher,
  SqlSession,
} from "../events/index.ts";
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
} from "../plugins/index.ts";
import type {
  ConnectAttachmentInput,
  RunHandle,
  RunInput,
  ThreadAttachment,
} from "../attachments/index.ts";
import type { ProgressiveBodyMaintenanceResult } from "../content/index.ts";
import type { ActionLifecycleEmitter } from "../actions/index.ts";

export type EphemeralEventInput = EphemeralEventDraft;
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

export type CopilotzEngineAttachmentOptions = Readonly<{
  /** Poll interval used while observing delivery settlement. */
  settlementPollMs?: number;
}>;

export type CreateCopilotzEngineOptions = Readonly<{
  session: SqlSession;
  registry: PluginRegistry;
  defaultDatabaseSchema?: string;
  /** Provision the default schema during engine startup. Set false to validate it only. */
  provisionDefaultDatabaseSchema?: boolean;
  execution?: CopilotzEngineExecutionOptions;
  attachments?: CopilotzEngineAttachmentOptions;
  eventHub?: CopilotzEventHub;
  publish?: EventPublisher;
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
}>;

export type CopilotzEngineDatabaseScope = Readonly<{
  databaseSchema: string;
  content: Readonly<{
    assets: DatabaseAssetRepository;
    preparer: ContentPreparer;
    resolver: ContentResolver;
  }>;
  collections: CollectionRuntime;
  connect(input: ConnectAttachmentInput): Promise<ThreadAttachment>;
  run(input: RunInput): Promise<RunHandle>;
  /** Terminates active text/realtime attachments without shutting down execution. */
  disconnectAttachments(error?: unknown): Promise<void>;
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
  }): Promise<CopilotzEngineMaintenanceResult>;
}>;

export type CopilotzEngine = Readonly<{
  databaseSchema: string;
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
  connect(input: ConnectAttachmentInput): Promise<ThreadAttachment>;
  run(input: RunInput): Promise<RunHandle>;
  disconnectAttachments(error?: unknown): Promise<void>;
  events: Readonly<{
    append(
      draft: DurableEventDraft,
      options?: { priority?: number; maxAttempts?: number },
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
    list(options: {
      namespace: string;
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
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
  publishEvent?: (event: CopilotzEvent) => Promise<void>;
  actionLifecycle: ActionLifecycleEmitter;
  now?: () => Date;
  streamBodyStore: BodyStore;
}>;

export type CopilotzEngineDispatchReport = EventDispatchReport;
export type CopilotzEnginePublishAssetInput = Omit<
  PublishAssetInput,
  "namespace"
>;
