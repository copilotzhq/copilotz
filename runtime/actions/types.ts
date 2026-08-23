import type { JSONSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CoordinatedMutationResult } from "../events/coordinator.ts";
import type { DurableEvent, DurableEventDraft } from "../events/types.ts";
import type { EventDelivery } from "../events/types.ts";
import type {
  DomainRelation,
  ListDomainRelationsOptions,
  ProjectDomainRelationInput,
} from "../domain/index.ts";
import type { ScopedCollections } from "../collections/kernel.ts";
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

export type ActionContextNamespace = Readonly<Record<string, unknown>>;

export type ActionContextNamespaces = Readonly<
  Record<string, ActionContextNamespace>
>;

export type ActionCollections = ScopedCollections;

/** Runtime-native durable content operations available to Actions. */
export type ActionContent = Readonly<{
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
}>;

export type ActionStreams = ContentStreamRuntime;

export type ActionIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
}>;

export type ActionCallOptions = Readonly<{
  operationKey?: string;
  identity?: ActionIdentity;
  signal?: AbortSignal;
}>;

export type ActionTransactionOptions = Readonly<{
  operationKey?: string;
  identity?:
    & ActionIdentity
    & Readonly<{
      metadata?: Readonly<Record<string, unknown>>;
    }>;
  signal?: AbortSignal;
}>;

export type ActionTransactionContext<
  TCollections extends ActionCollections = ActionCollections,
> = Readonly<{
  collections: TCollections;
  relations: Readonly<{
    /** Atomically creates or replaces one graph relation projection. */
    upsert(
      input: Omit<ProjectDomainRelationInput, "namespace">,
    ): Promise<DomainRelation>;
  }>;
}>;

/**
 * Runtime-owned Action context. Semantic Actions narrow this shape through an
 * ordinary interface; the runtime still passes the complete composed context.
 */
export interface ActionContext {
  readonly namespace: string;
  readonly operationKey: string;
  readonly identity: ActionIdentity;
  readonly action: Readonly<{
    id: string;
    runId: string;
    parentRunId?: string;
  }>;
  readonly resources: ActionContextNamespaces;
  readonly adapters: ActionContextNamespaces;
  readonly actions: Readonly<
    Record<
      string,
      (input: never, options?: ActionCallOptions) => Promise<unknown>
    >
  >;
  readonly collections: ActionCollections;
  readonly content: ActionContent;
  readonly streams: ActionStreams;
  readonly events: Readonly<{
    list(options?: {
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
  }>;
  readonly deliveries: Readonly<{
    list(options?: {
      eventId?: string;
      consumerId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
  }>;
  readonly relations: Readonly<{
    list(
      options?: Omit<ListDomainRelationsOptions, "namespace">,
    ): Promise<readonly DomainRelation[]>;
  }>;
  readonly signal?: AbortSignal;
  now(): Date;
  transaction<T>(
    execute: (
      context: ActionTransactionContext,
    ) => T | Promise<T>,
    options?: ActionTransactionOptions,
  ): Promise<T>;
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
