import type {
  ActionNamedPreparation,
  ActionPrepareNamedOptions,
} from "../execution/preparation-call.ts";
import type {
  ActionContinuation,
  AwaitingAction,
  AwaitOperationInput,
  OperationOutcome,
  OperationStart,
} from "./continuation.ts";
import type { VectorReader, VectorTransaction } from "../vectors/index.ts";
import type { ActionContentDeclaration } from "./content.ts";
import type { ExtendedJSONSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CoordinatedMutationResult } from "../events/coordinator.ts";
import type { DurableEvent, DurableEventDraft } from "../events/types.ts";
import type {
  CollectionTransactionRelations,
  ScopedCollection,
  ScopedCollections,
  SnapshotCollection,
  TransactionCollection,
} from "../collections/kernel.ts";
import type {
  ContentStreamOpenInput,
  ContentStreamRuntime,
  ContentStreamWriter,
} from "../streams/index.ts";
import type {
  AssetOrigin,
  AssetRecord,
  ContentInput,
  ContentRef,
  ContentSequence,
  DurableContentInput,
  GeneratedContentSequence,
  PreparedContent,
  PublishAssetInput,
  ResolvedContent,
} from "../content/types.ts";

export type RuntimeContextNamespace = Readonly<Record<string, unknown>>;

export type RuntimeContextNamespaces = Readonly<
  Record<string, RuntimeContextNamespace>
>;

export type RuntimeCollections = ScopedCollections;

export type RuntimeSnapshotCollections<
  TCollections extends RuntimeCollections = RuntimeCollections,
> = Readonly<
  {
    [K in keyof TCollections]: TCollections[K] extends ScopedCollection<
      infer TSelect,
      infer TInsert
    > ? SnapshotCollection<TSelect, TInsert>
      : SnapshotCollection;
  }
>;

export type RuntimeTransactionCollections<
  TCollections extends RuntimeCollections = RuntimeCollections,
> = Readonly<
  {
    [K in keyof TCollections]: TCollections[K] extends ScopedCollection<
      infer TSelect,
      infer TInsert
    > ? TransactionCollection<TSelect, TInsert>
      : TransactionCollection;
  }
>;

export type RuntimeActionCallers = Readonly<
  Record<
    string,
    & ((input: unknown, options?: ActionCallOptions) => Promise<unknown>)
    & Readonly<{
      prepareNamed(
        request: ActionNamedPreparation,
        options: ActionPrepareNamedOptions,
      ): Promise<unknown>;
      prepare(
        factory: ActionPrepareFactory,
        options: ActionPrepareOptions,
      ): Promise<unknown>;
    }>
  >
>;

/** Structural constraint accepted by a statically narrowed Action caller map. */
export type RuntimeActionCallerMap = Readonly<
  Record<string, (...args: never[]) => unknown>
>;

/** Runtime-native durable content operations available to Actions. */
export type RuntimeContent = Readonly<{
  authorize?(ref: ContentRef): Promise<void>;
  openCapture(
    input: ContentStreamOpenInput & { operationKey: string },
  ): Promise<ContentStreamWriter>;
  capture(
    input: ContentInput | readonly ContentInput[] | PreparedContent,
    options: { operationKey: string; origin?: AssetOrigin },
  ): Promise<GeneratedContentSequence>;
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: { operationKey: string; origin?: AssetOrigin },
  ): Promise<PreparedContent>;
  materialize(
    input: DurableContentInput,
    options?: { origin?: AssetOrigin },
  ): Promise<ContentSequence>;
  publish(
    input: Omit<PublishAssetInput, "namespace" | "idempotencyKey">,
    options: { operationKey: string },
  ): Promise<AssetRecord>;
  get(assetId: string): Promise<AssetRecord | null>;
  getMany(assetIds: readonly string[]): Promise<readonly AssetRecord[]>;
  resolve(ref: ContentRef): Promise<ResolvedContent>;
  resolveMany(refs: readonly ContentRef[]): Promise<readonly ResolvedContent[]>;
  open(ref: ContentRef): Promise<ReadableStream<Uint8Array>>;
}>;

/** Admit independent public work once per namespace-scoped operation key. */
export type RuntimeOperations = Readonly<{
  start(
    input: Omit<OperationStart, "operationId"> & { operationKey: string },
  ): Promise<string>;
}>;

export type RuntimeStreams = ContentStreamRuntime;

export type RuntimeIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
  /** Action lineage carried by durable execution. */
  actionScopeId?: string;
}>;

/** Caller-owned, JSON-safe data carried by one Action invocation. */
export type ActionInvocationMetadata = Readonly<Record<string, unknown>>;

/** JSON effect data. Plain confirm accepts only secret-free outcomes;
 * confirmOutput captures the complete registered protected Action output. */
export type ActionEffectOutcome =
  | null
  | boolean
  | number
  | string
  | readonly ActionEffectOutcome[]
  | { readonly [key: string]: ActionEffectOutcome };
/** Opaque evidence verified against current owner dispatch facts. */
export type ActionEffectEvidence = Readonly<
  { source: string; reference: string }
>;
export type ActionEffectOptions = Readonly<{ signal?: AbortSignal }>;
export type ActionEffectState =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "indeterminate" }>
  | Readonly<{ status: "not_started" }>
  | Readonly<{ status: "replay"; outcome: ActionEffectOutcome }>;
export type ActionEffectBegin =
  | Readonly<{ status: "proceed" | "not_started" }>
  | Readonly<{ status: "replay"; outcome: ActionEffectOutcome }>;
export type ActionReconcileResult =
  | Readonly<{ status: "confirmed"; outcome: ActionEffectOutcome }>
  | Readonly<{ status: "not_started"; evidence: ActionEffectEvidence }>
  | Readonly<{ status: "indeterminate" }>;
/** Invocation-bound effect capability. Only a fresh begin's proceed permits one
 * external dispatch. A closed step is never reopened; use a new deterministic
 * step after owner-verified not_started when another dispatch is intended. */
export type ActionEffect = Readonly<{
  begin(
    step: string,
    options?: ActionEffectOptions,
  ): Promise<ActionEffectBegin>;
  inspect(
    step: string,
    options?: ActionEffectOptions,
  ): Promise<ActionEffectState>;
  confirm(
    step: string,
    outcome: ActionEffectOutcome,
    options?: ActionEffectOptions,
  ): Promise<void>;
  /** Atomically retain this Action's complete declared protected output and confirm the step. */
  confirmOutput(
    step: string,
    output: ActionEffectOutcome,
    options?: ActionEffectOptions,
  ): Promise<void>;
  notStarted(
    step: string,
    evidence: ActionEffectEvidence,
    options?: ActionEffectOptions,
  ): Promise<void>;
}>;

export type ActionCallOptions = Readonly<{
  operationKey?: string;
  identity?: RuntimeIdentity;
  metadata?: ActionInvocationMetadata;
  signal?: AbortSignal;
}>;

/** Values captured together by a awaiting Action invocation. */
export type ActionPreparedCall<I = unknown> = Readonly<{
  input: I;
  metadata?: ActionInvocationMetadata;
}>;

/** Stable identity for an Action input that is prepared only when needed. */
export type ActionPrepareOptions =
  & Omit<ActionCallOptions, "metadata" | "operationKey">
  & Readonly<{ operationKey: string }>;

export type ActionPrepareFactory<I = unknown> = () =>
  | ActionPreparedCall<I>
  | Promise<ActionPreparedCall<I>>;

export type ActionTransactionOptions = Readonly<{
  operationKey?: string;
  identity?:
    & RuntimeIdentity
    & Readonly<{
      metadata?: Readonly<Record<string, unknown>>;
    }>;
  signal?: AbortSignal;
}>;

export type ActionTransactionContext<
  TCollections extends RuntimeCollections = RuntimeCollections,
> = Readonly<{
  collections: RuntimeTransactionCollections<TCollections>;
  relations: CollectionTransactionRelations;
  vectors: VectorTransaction;
}>;

/**
 * Runtime-owned context shared by Actions and Processors. `databaseSchema` is
 * the immutable physical persistence scope selected by the runtime for this
 * execution; it is not Action metadata or caller-controlled input. Semantic
 * code may narrow the composed maps through an ordinary TypeScript interface;
 * the runtime still passes the complete context without filtering it.
 */
export interface RuntimeContext<
  TResources extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TAdapters extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TActions extends RuntimeActionCallerMap = RuntimeActionCallers,
  TCollections extends RuntimeCollections = RuntimeCollections,
> {
  readonly namespace: string;
  readonly databaseSchema: string;
  readonly operationKey: string;
  readonly identity: RuntimeIdentity;
  readonly resources: TResources;
  readonly adapters: TAdapters;
  readonly actions: TActions;
  readonly collections: TCollections;
  readonly vectors: VectorReader;
  readonly content: RuntimeContent;
  readonly streams: RuntimeStreams;
  readonly operations: RuntimeOperations;
  readonly signal: AbortSignal;
  now(): Date;
  transaction<T>(
    execute: (
      context: ActionTransactionContext<TCollections>,
    ) => T | Promise<T>,
    options?: ActionTransactionOptions,
  ): Promise<T>;
  /**
   * Captures a short repeatable, read-only database snapshot for metadata
   * selection. Finish it before resolving remote content or calling providers.
   */
  readSnapshot<T>(
    execute: (
      context: Readonly<{
        collections: RuntimeSnapshotCollections<TCollections>;
      }>,
    ) => T | Promise<T>,
  ): Promise<T>;
}

/** Runtime context for one Action invocation and its durable lifecycle. */
export interface ActionContext<
  TResources extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TAdapters extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TActions extends RuntimeActionCallerMap = RuntimeActionCallers,
  TCollections extends RuntimeCollections = RuntimeCollections,
> extends RuntimeContext<TResources, TAdapters, TActions, TCollections> {
  readonly action: Readonly<{
    id: string;
    runId: string;
    parentRunId?: string;
    metadata: ActionInvocationMetadata;
  }>;
  readonly effect: ActionEffect;
  /** Persists one self-contained `<actionId>.progress` lifecycle Event. */
  progress(value: unknown): Promise<void>;
  /** Declare a durable continuation and release this execution slot. */
  awaitOperation(input: AwaitOperationInput): ActionContinuation;
}

type ActionSchemaExtensions = Readonly<{
  "x-copilotz-secret": boolean;
  $defs: Readonly<
    Record<string, ExtendedJSONSchema<ActionSchemaExtensions>>
  >;
  prefixItems: readonly ExtendedJSONSchema<ActionSchemaExtensions>[];
  dependentSchemas: Readonly<
    Record<string, ExtendedJSONSchema<ActionSchemaExtensions>>
  >;
  unevaluatedProperties: ExtendedJSONSchema<ActionSchemaExtensions>;
  example: unknown;
}>;

/** JSON Schema object with the recursively typed Copilotz secret extension. */
export type ActionSchema = Exclude<
  ExtendedJSONSchema<ActionSchemaExtensions>,
  boolean
>;

declare const actionDefinitionTypes: unique symbol;

/** One executable capability. The symbol member carries types only. */
export type ActionDefinition<
  TInput = unknown,
  TOutput = unknown,
  TContext = ActionContext,
  TInputSchema extends ActionSchema | undefined = ActionSchema | undefined,
  TOutputSchema extends ActionSchema | undefined = ActionSchema | undefined,
> = Readonly<{
  id: string;
  ownerHooks?: Readonly<{ prepareInput?: true; acceptOutput?: true }>;
  content?: ActionContentDeclaration;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  execute(
    input: TInput,
    context: TContext,
  ): TOutput | Promise<TOutput>;
  reconcile?(
    step: string,
    context: TContext,
  ): ActionReconcileResult | Promise<ActionReconcileResult>;
  resume?(
    handoff: unknown,
    outcome: OperationOutcome,
    context: TContext,
  ):
    | Exclude<TOutput, ActionContinuation>
    | ActionContinuation
    | Promise<Exclude<TOutput, ActionContinuation> | ActionContinuation>;
  readonly [actionDefinitionTypes]?: Readonly<{
    input: TInput;
    output: TOutput;
    context: TContext;
  }>;
}>;

export type AnyActionDefinition = Readonly<{
  id: string;
  ownerHooks?: Readonly<{ prepareInput?: true; acceptOutput?: true }>;
  content?: ActionContentDeclaration;
  inputSchema?: ActionSchema;
  outputSchema?: ActionSchema;
  execute: (...args: never[]) => unknown;
  resume?: (...args: never[]) => unknown;
  reconcile?: (
    ...args: never[]
  ) => ActionReconcileResult | Promise<ActionReconcileResult>;
  readonly [actionDefinitionTypes]?: Readonly<{
    input: unknown;
    output: unknown;
    context: unknown;
  }>;
}>;

export type ActionMap = Readonly<Record<string, AnyActionDefinition>>;

type ActionDefinitionTypes<A extends AnyActionDefinition> = NonNullable<
  A[typeof actionDefinitionTypes]
>;

export type ActionInput<A extends AnyActionDefinition> = ActionDefinitionTypes<
  A
>["input"];

type ActionCallResult<T> = T extends ActionContinuation ? AwaitingAction : T;
export type ActionOutput<A extends AnyActionDefinition> = ActionCallResult<
  ActionDefinitionTypes<
    A
  >["output"]
>;

export type ActionContextOf<A extends AnyActionDefinition> =
  ActionDefinitionTypes<A>["context"];

export type ActionCaller<A extends AnyActionDefinition> = (
  input: ActionInput<A>,
  options?: ActionCallOptions,
) => Promise<ActionOutput<A>>;

/** A runtime-bound Action caller, including awaiting input capture. */
export type BoundActionCaller<A extends AnyActionDefinition> =
  & ActionCaller<A>
  & Readonly<{
    /**
     * Captures dynamic input and metadata once under `operationKey`. Existing
     * Action receipts are restored before the factory is evaluated.
     */
    prepareNamed(
      request: ActionNamedPreparation,
      options: ActionPrepareNamedOptions,
    ): Promise<ActionOutput<A>>;
    prepare(
      factory: ActionPrepareFactory<ActionInput<A>>,
      options: ActionPrepareOptions,
    ): Promise<ActionOutput<A>>;
  }>;

export type ActionCallers<TActions extends ActionMap = ActionMap> = Readonly<
  {
    [K in keyof TActions]: BoundActionCaller<TActions[K]>;
  }
>;

export type ActionStatus =
  | "invoked"
  | "awaiting"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

export type SerializedActionError = Readonly<{
  name: string;
  message: string;
  code?: string;
  callerSafe?: true;
  status?: number;
}>;

type ActionEventBase<I> = Readonly<{
  actionRunId: string;
  actionId: string;
  parentActionRunId?: string;
  metadata: ActionInvocationMetadata;
  input: I;
}>;

export type ActionInvokedData<I = unknown> =
  & ActionEventBase<I>
  & Readonly<{ status: "invoked"; effectProtocol?: 1 }>;

export type ActionAwaitingData<I = unknown> =
  & AwaitOperationInput
  & ActionEventBase<I>
  & Readonly<
    {
      status: "awaiting";
      progressIndex: number;
    }
  >;

export type ActionCompletedData<I = unknown, O = unknown> =
  & ActionEventBase<I>
  & Readonly<{
    status: "completed";
    output: O;
  }>;

export type ActionProgressData<I = unknown, P = unknown> =
  & ActionEventBase<I>
  & Readonly<{
    status: "progress";
    progressIndex: number;
    progress: P;
  }>;

export type ActionFailedData<I = unknown> =
  & ActionEventBase<I>
  & Readonly<{
    status: "failed" | "cancelled";
    error: SerializedActionError;
  }>;

export type ActionEventData<I = unknown, O = unknown, P = unknown> =
  | ActionInvokedData<I>
  | ActionAwaitingData<I>
  | ActionProgressData<I, P>
  | ActionCompletedData<I, O>
  | ActionFailedData<I>;

type ActionLifecycleEnvelope = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId: string;
  settlementScopeId?: string;
  /** Action lineage carried by durable execution. */
  actionScopeId?: string;
}>;

export type ActionLifecycleInput<I = unknown, O = unknown, P = unknown> =
  & ActionEventData<I, O, P>
  & ActionLifecycleEnvelope;

export type ActionLifecycleAppendInput = Readonly<{
  draft: Omit<DurableEventDraft, "payload">;
  data: ActionEventData;
}>;

export type ActionLifecycleEmitter = Readonly<{
  emit<I = unknown, O = unknown, P = unknown>(
    input: ActionLifecycleInput<I, O, P>,
  ): Promise<CoordinatedMutationResult<void> | DurableEvent>;
  invoked(actionRunId: string): Promise<ActionInvokedData | null>;
  awaiting?(actionRunId: string): Promise<ActionAwaitingData | null>;
  terminal(
    actionRunId: string,
  ): Promise<ActionCompletedData | ActionFailedData | null>;
}>;

export type ActionLifecycleAppender = (
  input: ActionLifecycleAppendInput,
) => Promise<CoordinatedMutationResult<void>>;

export type ActionLifecycleLoader = (
  namespace: string,
  deduplicationId: string,
) => Promise<ActionEventData | null>;
