import type { OwnerIngressProof } from "../application/ingress/authority.ts";
import type { OwnerAlarmScheduler } from "./alarms.ts";
import type { DeliveryScopeOutstanding } from "../events/store.ts";
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
  /** Action lineage carried by durable execution. */
  actionScopeId?: string;
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

/** Owner-local proof adapter. Evidence is never trusted merely because a worker sent it. */
export type EffectNoStartVerifier = (
  reference: Readonly<
    {
      databaseSchema: string;
      namespace: string;
      actionRunId: string;
      step: string;
    }
  >,
  evidence: import("../actions/types.ts").ActionEffectEvidence,
  options: Readonly<{ signal: AbortSignal }>,
) => boolean | Promise<boolean>;
export type CreateCopilotzEngineOptions = Readonly<{
  authorization?: import("../authorization/evaluator.ts").OwnerAuthorization;
  verifyEffectNotStarted?: EffectNoStartVerifier;
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
  /** One platform alarm per database owner. */
  alarmScheduler?: OwnerAlarmScheduler;
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
  authorization: import("../authorization/owner.ts").AuthorizationOwner;
  observeCollection: import("../subscriptions/types.ts").CollectionObserver;
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
  authorization: import("../authorization/owner.ts").AuthorizationOwner;
  observeCollection: import("../subscriptions/types.ts").CollectionObserver;
  databaseSchema: string;
  operations: OperationCatalog;
  databaseScope(databaseSchema: string): Promise<CopilotzEngineDatabaseScope>;
  plugins: PluginRegistry;
  execution: Readonly<{
    ownership: DeliveryExecutorOwnership;
    workload: string;
    createWorkerWorkloads:
      import("../execution/workload.ts").OwnerExecutionFactory;
    lookupReceipt(
      identity:
        import("../../dependencies/oxian-hypervisor.ts").WorkerCallContext[
          "fence"
        ]["identity"],
      input: unknown,
    ): Promise<boolean>;
    resolveAuthority(
      schema: string,
    ): Promise<Readonly<{ epoch: number; signal: AbortSignal }>>;
    /** Portable handlers for the current worker connection. */
    workloads: Readonly<Record<string, DeliveryWorkload>>;
    dispatchWork(input: ExecutionWorkInput): Promise<ExecutionWorkHandle>;
    /** Waits until output already relayed for one durable causal scope settles. */
    settleOutputs(scope: {
      databaseSchema?: string;
      namespace: string;
      settlementScopeId: string;
    }): Promise<void>;
    /** Waits until local work for one durable causal scope finishes, if any runs. */
    awaitScopeProgress(scope: {
      databaseSchema?: string;
      namespace: string;
      settlementScopeId: string;
    }, signal?: AbortSignal): Promise<boolean>;
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
      options?: { maxAttempts?: number },
    ): Promise<CoordinatedMutationResult<void>>;
    /** Internal bridge ingress that seals schema-marked values before commit. */
    appendProtected(
      draft: DurableEventDraft,
      schema: ActionSchema,
      ownerId: string,
      ingress?: OwnerIngressProof,
      completion?:
        import("../application/ingress/inline-collection.ts").InlineCollectionCompletion,
      inlineAction?: boolean,
    ): Promise<CoordinatedMutationResult<void>>;
    emit(input: EphemeralEventInput): Promise<EphemeralEvent>;
    subscribe(filter?: CopilotzEventFilter): ReadableStream<CopilotzEvent>;
    waitFor(
      filter: CopilotzEventFilter & {
        namespace: string;
        timeoutMs?: number;
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
      metadata?: Readonly<Record<string, unknown>>;
      correlationId?: string;
      afterPosition?: string;
      afterSeq?: string;
      order?: "asc" | "desc";
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
    settlement(
      namespace: string,
      settlementScopeId: string,
    ): Promise<DeliveryScopeSettlement>;
    /** Internal completion check that skips successful delivery history. */
    outstanding(
      namespace: string,
      settlementScopeId: string,
    ): Promise<DeliveryScopeOutstanding>;
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
      settlementScopeId?: string;
      /** Action lineage carried by durable execution. */
      actionScopeId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
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
  ): Promise<() => void>;
}>;

export type CreateProcessorContextOptions = Readonly<{
  collectionInvocation?: Readonly<{
    owner: Parameters<
      typeof import("../authorization/invocation.ts").bindProcessorCollectionInvocation
    >[1];
    invocation: import("../authorization/intent.ts").CollectionPolicyInvocation;
  }>;
  operations: import("../actions/types.ts").RuntimeOperations;
  base: EngineContextSeed;
  registry: PluginRegistry;
  assets: DatabaseAssetRepository;
  preparer: ContentPreparer;
  resolver: ContentResolver;
  collections: CollectionRuntime;
  eventHub: CopilotzEventHub;
  publishOutput?: (output: RuntimeOutputDescriptor) => Promise<void>;
  publishLocalStream?: (output: StreamOutput) => Promise<void>;
  createEffectClient?:
    import("../actions/invoker.ts").CreateActionCallersOptions[
      "createEffectClient"
    ];
  authorizeAction?:
    import("../actions/invoker.ts").CreateActionCallersOptions["authorize"];
  refuseActionAuthorization?:
    import("../actions/invoker.ts").CreateActionCallersOptions[
      "refuseAuthorization"
    ];
  prepareActionInput?:
    import("../actions/invoker.ts").CreateActionCallersOptions["prepareInput"];
  actionLifecycle: ActionLifecycleEmitter;
  actionResumption?:
    import("../actions/invoker.ts").CreateActionCallersOptions["resumption"];
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
