import type { JSONSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CoordinatedMutationResult } from "../events/coordinator.ts";
import type { DurableEvent, DurableEventDraft } from "../events/types.ts";
import type {
  CollectionTransactionRelations,
  ScopedCollection,
  ScopedCollections,
  TransactionCollection,
} from "../collections/kernel.ts";
import type { ContentStreamRuntime } from "../content/stream.ts";
import type {
  AssetOrigin,
  AssetRecord,
  ContentInput,
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedContent,
  PublishAssetInput,
  ResolvedContent,
} from "../content/types.ts";

export type RuntimeContextNamespace = Readonly<Record<string, unknown>>;

export type RuntimeContextNamespaces = Readonly<
  Record<string, RuntimeContextNamespace>
>;

export type RuntimeCollections = ScopedCollections;

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
    (input: unknown, options?: ActionCallOptions) => Promise<unknown>
  >
>;

/** Structural constraint accepted by a statically narrowed Action caller map. */
export type RuntimeActionCallerMap = Readonly<
  Record<string, (...args: never[]) => unknown>
>;

/** Runtime-native durable content operations available to Actions. */
export type RuntimeContent = Readonly<{
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

export type RuntimeStreams = ContentStreamRuntime;

export type RuntimeIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
}>;

/** Caller-owned, JSON-safe data carried by one Action invocation. */
export type ActionInvocationMetadata = Readonly<Record<string, unknown>>;

export type ActionCallOptions = Readonly<{
  operationKey?: string;
  identity?: RuntimeIdentity;
  metadata?: ActionInvocationMetadata;
  signal?: AbortSignal;
}>;

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
}>;

/**
 * Runtime-owned context shared by Actions and Processors. Semantic code may
 * narrow the composed maps through an ordinary TypeScript interface; the
 * runtime still passes the complete context without filtering it.
 */
export interface RuntimeContext<
  TResources extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TAdapters extends RuntimeContextNamespaces = RuntimeContextNamespaces,
  TActions extends RuntimeActionCallerMap = RuntimeActionCallers,
  TCollections extends RuntimeCollections = RuntimeCollections,
> {
  readonly namespace: string;
  readonly operationKey: string;
  readonly identity: RuntimeIdentity;
  readonly resources: TResources;
  readonly adapters: TAdapters;
  readonly actions: TActions;
  readonly collections: TCollections;
  readonly content: RuntimeContent;
  readonly streams: RuntimeStreams;
  readonly signal: AbortSignal;
  now(): Date;
  transaction<T>(
    execute: (
      context: ActionTransactionContext<TCollections>,
    ) => T | Promise<T>,
    options?: ActionTransactionOptions,
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
  /** Persists one self-contained `<actionId>.progress` lifecycle Event. */
  progress(value: unknown): Promise<void>;
}

export type ActionSchema = Exclude<JSONSchema, boolean>;

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
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  execute(
    input: TInput,
    context: TContext,
  ): TOutput | Promise<TOutput>;
  readonly [actionDefinitionTypes]?: Readonly<{
    input: TInput;
    output: TOutput;
    context: TContext;
  }>;
}>;

export type AnyActionDefinition = Readonly<{
  id: string;
  inputSchema?: ActionSchema;
  outputSchema?: ActionSchema;
  execute: (...args: never[]) => unknown;
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

export type ActionOutput<A extends AnyActionDefinition> = ActionDefinitionTypes<
  A
>["output"];

export type ActionContextOf<A extends AnyActionDefinition> =
  ActionDefinitionTypes<A>["context"];

export type ActionCaller<A extends AnyActionDefinition> = (
  input: ActionInput<A>,
  options?: ActionCallOptions,
) => Promise<ActionOutput<A>>;

export type ActionCallers<TActions extends ActionMap = ActionMap> = Readonly<
  {
    [K in keyof TActions]: ActionCaller<TActions[K]>;
  }
>;

export type ActionStatus =
  | "invoked"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

export type SerializedActionError = Readonly<{
  name: string;
  message: string;
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
  & Readonly<{ status: "invoked" }>;

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
  | ActionProgressData<I, P>
  | ActionCompletedData<I, O>
  | ActionFailedData<I>;

type ActionLifecycleEnvelope = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId: string;
  settlementScopeId?: string;
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
