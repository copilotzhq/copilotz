import type {
  AssetOrigin,
  AssetRecord,
  AuthorizeContent,
  BodyStorageOptions,
  BodyStorageRuntime,
  BodyStore,
  ContentInput,
  ContentPreparer,
  ContentRef,
  ContentResolver,
  ContentSequence,
  ContentStreamRuntime,
  DatabaseAssetRepository,
  DurableContentInput,
  PreparedContent,
  PublishAssetInput,
  ResolvedContent,
} from "../content/index.ts";
import type {
  AddThreadParticipantInput,
  CancelLlmAttemptInput,
  CancelToolExecutionInput,
  CompleteLlmAttemptInput,
  CompleteToolExecutionInput,
  ConversationMessage,
  ConversationRepository,
  ConversationThread,
  CreateDomainRelationInput,
  CreateLlmAttemptInput,
  CreateMessageInput,
  CreateParticipantInput,
  CreateThreadInput,
  CreateToolExecutionInput,
  DeleteDomainRelationInput,
  DeleteThreadMessagesResult,
  DeleteThreadResult,
  DomainRelation,
  DomainRelationRepository,
  EventCollections,
  FailLlmAttemptInput,
  FailToolExecutionInput,
  ListDomainRelationsOptions,
  LlmAttempt,
  MessageRevisionResult,
  MutationIdentity,
  Participant,
  ParticipantPatch,
  ReviseMessageInput,
  ThreadPatch,
  ToolExecution,
  UpdateLlmAttemptInput,
  UpdateToolExecutionInput,
  ValidateCollectionRecord,
} from "../domain/index.ts";
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
  EventStore,
  SqlExecutor,
  SqlSession,
} from "../events/index.ts";
import type {
  CreateDeliveryExecutorOptions,
  DeliveryContextBase,
  DeliveryExecutorOwnership,
  DeliveryRecoveryDispatch,
  DeliveryWorkload,
  ExecutionWorkHandle,
  ExecutionWorkInput,
  LiveProcessorContextBase,
} from "../execution/index.ts";
import type {
  CollectionRuntime,
  ScopedCollections,
} from "../collections/index.ts";
import type {
  AnyFeatureDefinition,
  FeatureActionsFor,
  FeatureContextValues,
  FeatureInvoker,
} from "../features/index.ts";
import type { PluginRegistry, Processor } from "../plugins/index.ts";
import type {
  ConnectAttachmentInput,
  RunHandle,
  RunInput,
  ThreadAttachment,
} from "../attachments/index.ts";
import type {
  ScheduledJobTrigger,
  ScopedScheduledJobTrigger,
} from "../schedules/index.ts";
import type { ProgressiveBodyMaintenanceResult } from "../content/index.ts";
import type { MemoryKindDefinition } from "../memory/ontology.ts";

export type ScopedMutationOptions = Readonly<{
  operationKey?: string;
  metadata?: Record<string, unknown>;
}>;

export type EphemeralEventInput = EphemeralEventDraft;

export type ScopedEphemeralEventInput =
  & Omit<
    EphemeralEventInput,
    "namespace" | "correlationId" | "causationId"
  >
  & Readonly<{
    correlationId?: string;
    causationId?: string;
  }>;

export type ScopedEventWaitOptions =
  & Omit<
    CopilotzEventFilter,
    "namespace"
  >
  & Readonly<{
    timeoutMs?: number;
    pollIntervalMs?: number;
  }>;

export type ScopedEvents = Readonly<{
  emit(input: ScopedEphemeralEventInput): Promise<EphemeralEvent>;
  list(
    options?: Omit<CopilotzEventFilter, "namespace" | "durable"> & {
      limit?: number;
    },
  ): Promise<readonly DurableEvent[]>;
  waitFor(options: ScopedEventWaitOptions): Promise<CopilotzEvent>;
}>;

export type ScopedContent = Readonly<{
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: { operationKey: string; origin?: AssetOrigin },
  ): Promise<PreparedContent>;
  materialize(
    input: DurableContentInput,
    options?: { origin?: AssetOrigin },
  ): Promise<ContentSequence>;
  linkOwner(ownerId: string, content: ContentSequence): Promise<void>;
  publish(
    input: Omit<PublishAssetInput, "namespace" | "idempotencyKey">,
    options: { operationKey: string },
  ): Promise<AssetRecord>;
  get(assetId: string): Promise<AssetRecord | null>;
  getMany(assetIds: readonly string[]): Promise<readonly AssetRecord[]>;
  resolve(ref: ContentRef): Promise<ResolvedContent>;
  resolveMany(refs: readonly ContentRef[]): Promise<readonly ResolvedContent[]>;
  open(ref: ContentRef): Promise<ReadableStream<Uint8Array>>;
  /** Runtime-native progressive content production. Creates no graph state. */
  stream?: ContentStreamRuntime;
}>;

export type ScopedConversation = Readonly<{
  createParticipant(
    input: Omit<CreateParticipantInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<Participant>>;
  updateParticipant(
    id: string,
    patch: ParticipantPatch,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<Participant>>;
  getParticipant(id: string): Promise<Participant | null>;
  getParticipantByExternalId(externalId: string): Promise<Participant | null>;
  listParticipants(
    options?: Parameters<ConversationRepository["listParticipants"]>[1],
  ): Promise<readonly Participant[]>;
  createThread(
    input: Omit<CreateThreadInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  addThreadParticipant(
    input: Omit<AddThreadParticipantInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  updateThread(
    id: string,
    patch: ThreadPatch,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  deleteThread(
    id: string,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<DeleteThreadResult>>;
  getThread(id: string): Promise<ConversationThread | null>;
  getThreadByExternalId(externalId: string): Promise<ConversationThread | null>;
  listThreads(
    options?: Parameters<ConversationRepository["listThreads"]>[1],
  ): Promise<readonly ConversationThread[]>;
  createMessage(
    input: Omit<CreateMessageInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ConversationMessage>>;
  reviseMessage(
    input: Omit<ReviseMessageInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<MessageRevisionResult>>;
  deleteThreadMessages(
    threadId: string,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<DeleteThreadMessagesResult>>;
  getMessage(id: string): Promise<ConversationMessage | null>;
  listMessages(
    threadId: string,
    options?: Parameters<ConversationRepository["listMessages"]>[2],
  ): Promise<readonly ConversationMessage[]>;
  listMessageRevisions(
    rootMessageId: string,
  ): Promise<readonly ConversationMessage[]>;
}>;

export type ScopedLlmAttempts = Readonly<{
  create(
    input: Omit<CreateLlmAttemptInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  update(
    input: Omit<UpdateLlmAttemptInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  complete(
    input: Omit<CompleteLlmAttemptInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  fail(
    input: Omit<FailLlmAttemptInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  cancel(
    input: Omit<CancelLlmAttemptInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  get(id: string): Promise<LlmAttempt | null>;
  list(
    threadId: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly LlmAttempt[]>;
}>;

export type ScopedToolExecutions = Readonly<{
  create(
    input: Omit<CreateToolExecutionInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  update(
    input: Omit<UpdateToolExecutionInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  complete(
    input: Omit<CompleteToolExecutionInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  fail(
    input: Omit<FailToolExecutionInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  cancel(
    input: Omit<CancelToolExecutionInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  get(id: string): Promise<ToolExecution | null>;
  /** Returns the latest execution carrying this provider call label. */
  getByToolCallId(
    threadId: string,
    toolCallId: string,
  ): Promise<ToolExecution | null>;
  getByMessageToolCallId(
    threadId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<ToolExecution | null>;
  list(
    threadId: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly ToolExecution[]>;
}>;

export type ScopedRelations = Readonly<{
  create(
    input: Omit<CreateDomainRelationInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<DomainRelation>>;
  delete(
    input: Omit<DeleteDomainRelationInput, "namespace" | "identity">,
    options?: ScopedMutationOptions,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(id: string): Promise<DomainRelation | null>;
  list(
    options?: Omit<ListDomainRelationsOptions, "namespace">,
  ): Promise<readonly DomainRelation[]>;
}>;

export type CopilotzProcessorCapabilities =
  & FeatureContextValues
  & Readonly<{
    namespace: string;
    events: ScopedEvents;
    content: ScopedContent;
    collections: ScopedCollections;
    relations: ScopedRelations;
    schedules: ScopedScheduledJobTrigger;
    memoryKinds: Readonly<Record<string, MemoryKindDefinition | undefined>>;
    /** Reusable plugin commands. Joins this delivery's collection runtime. */
    features: FeatureInvoker;
    /** Invoke a Feature by definition. Consumer-local aliases live on `features`. */
    feature<F extends AnyFeatureDefinition>(
      definition: F,
    ): FeatureActionsFor<F>;
  }>;

export type CopilotzProcessorContext =
  & DeliveryContextBase
  & CopilotzProcessorCapabilities;

export type CopilotzLiveProcessorContext =
  & LiveProcessorContextBase
  & CopilotzProcessorCapabilities;

export type CopilotzMutationIdentityFactory = (
  operationKey: string,
  metadata?: Record<string, unknown>,
) => MutationIdentity;

export type CopilotzCapabilitySource = Readonly<{
  kind: "delivery" | "stream" | "live";
  id: string;
  consumerId?: string;
}>;

/** Durable settlement scope used to bind domain capabilities outside a delivery. */
export type CopilotzCapabilityBase = Readonly<{
  databaseSchema: string;
  event: CopilotzEvent;
  signal: AbortSignal;
  settlementScopeId?: string;
  createMutationIdentity: CopilotzMutationIdentityFactory;
  source?: CopilotzCapabilitySource;
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
  validateCollection?: ValidateCollectionRecord;
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
  transientProcessors?: readonly Processor[];
}>;

export type CopilotzEngineMaintenanceResult = Readonly<{
  recovered: number;
  dispatchFailures: number;
  compacted: Readonly<{ events: number; deliveries: number }>;
  progressiveBodies: ProgressiveBodyMaintenanceResult;
  assets: Readonly<{
    retriedDeletions: number;
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
  collections: EventCollections;
  collectionRuntime: CollectionRuntime;
  relations: DomainRelationRepository;
  schedules: ScheduledJobTrigger;
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
  }>;
  content: Readonly<{
    assets: DatabaseAssetRepository;
    preparer: ContentPreparer;
    resolver: ContentResolver;
  }>;
  collections: EventCollections;
  collectionRuntime: CollectionRuntime;
  relations: DomainRelationRepository;
  schedules: ScheduledJobTrigger;
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

export type CreateCopilotzProcessorCapabilitiesOptions = Readonly<{
  base: CopilotzCapabilityBase;
  registry: PluginRegistry;
  assets: DatabaseAssetRepository;
  preparer: ContentPreparer;
  resolver: ContentResolver;
  collections: EventCollections;
  relations: DomainRelationRepository;
  schedules: ScheduledJobTrigger;
  eventHub: CopilotzEventHub;
  publishEvent?: (event: CopilotzEvent) => Promise<void>;
  eventStore: Pick<EventStore, "listDeliveries" | "listEvents" | "tables">;
  session: SqlExecutor;
  now?: () => Date;
  collectionRuntime: CollectionRuntime;
  streamBodyStore: BodyStore;
}>;

export type CopilotzEngineDispatchReport = EventDispatchReport;
export type CopilotzEnginePublishAssetInput = Omit<
  PublishAssetInput,
  "namespace"
>;
