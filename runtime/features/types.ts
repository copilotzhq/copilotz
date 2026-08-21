import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type { FromSchema } from "../../dependencies/json-schema-to-ts.ts";
import type { CollectionRuntime } from "../collections/index.ts";
import type {
  CollectionRecord,
  CollectionWriteOptions,
  ScopedCollection,
  ScopedCollections,
} from "../collections/index.ts";
import type {
  AssetOrigin,
  BodyStore,
  ContentResolver,
  ContentSequence,
  ContentStreamRuntime,
  DurableContentInput,
} from "../content/index.ts";
import type {
  DomainRelation,
  ListDomainRelationsOptions,
  ProjectDomainRelationInput,
} from "../domain/index.ts";
import type { DurableEvent, EventDelivery } from "../events/index.ts";
import type { LlmResource } from "../llm/index.ts";
import type { ContextResource } from "../context/types.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import type { Agent, API, MCPServer, Skill, Tool } from "../resources/index.ts";

/** HTTP projection of a feature invoke. Not the feature action signature. */
export type FeatureRequest = Readonly<{
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: readonly string[];
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  context?: Readonly<
    Record<string, unknown> & {
      namespace?: string;
      databaseSchema?: string;
    }
  >;
}>;

export type FeatureResponse = Readonly<{
  status: number;
  /** Transport headers such as Set-Cookie or a content disposition. */
  headers?: HeadersInit;
  data?: unknown;
  /** Canonical related resources requested through an `include` query. */
  included?: unknown;
  pageInfo?: Readonly<{
    next?: string;
    hasMore: boolean;
  }>;
}>;

/** @deprecated Phase 10 removed action effects. */
export type FeatureOperationIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
}>;

export type FeatureOperationOptions = Readonly<{
  operationKey?: string;
  identity?: FeatureOperationIdentity;
  signal?: AbortSignal;
}>;

/** Erased internal call options for Feature invocation. */
export type FeatureCallOptions = FeatureOperationOptions;

type ActionSchema<A> = A extends {
  readonly inputSchema: infer S extends JsonSchema;
} ? S
  : undefined;

type ActionExecuteResult<A> = A extends (...args: never[]) => infer O ? O
  : A extends { readonly execute: (...args: never[]) => infer O } ? O
  : unknown;

type ActionOutput<A> = A extends {
  readonly outputSchema: infer S extends JsonSchema;
} ? FeatureSchemaInput<S>
  : Awaited<ActionExecuteResult<A>>;

type FeatureSchemaInput<S> = S extends JsonSchema
  ? [JsonSchema] extends [S] ? unknown : FromSchema<S>
  : unknown;

export type FeatureActionInvoker<A = ErasedFeatureAction> = (
  input: FeatureSchemaInput<ActionSchema<A>>,
  options?: FeatureCallOptions,
) => Promise<ActionOutput<A>>;

export type FeatureAliasDefinitions = Readonly<
  Record<string, AnyFeatureDefinition>
>;

export type FeatureContextNamespace = Readonly<
  Record<string, unknown | undefined>
>;

export type FeatureContextValues = Readonly<{
  agents: Readonly<Record<string, Agent | undefined>>;
  tools: Readonly<Record<string, Tool | undefined>>;
  llm: Readonly<Record<string, LlmResource | undefined>>;
  apis: Readonly<Record<string, API | undefined>>;
  mcp: Readonly<Record<string, MCPServer | undefined>>;
  skills: Readonly<Record<string, Skill | undefined>>;
  embeddings: Readonly<Record<string, unknown | undefined>>;
  promptContext: Readonly<Record<string, ContextResource | undefined>>;
  featureDefinitions: Readonly<
    Record<string, AnyFeatureDefinition | undefined>
  >;
}>;

type CollectionSelect<D> = D extends {
  readonly $inferSelect: infer T extends CollectionRecord;
} ? T
  : CollectionRecord;

type CollectionInsert<D> = D extends {
  readonly $inferInsert: infer T extends object;
} ? T
  : Record<string, unknown>;

type ScopedCollectionFor<D> = ScopedCollection<
  CollectionSelect<D>,
  CollectionInsert<D>
>;

export type FeatureActionsFor<
  F extends AnyFeatureDefinition,
> = {
  readonly [A in keyof F["actions"]]: FeatureActionInvoker<F["actions"][A]>;
};

export type FeatureInvoker<
  TAliases extends FeatureAliasDefinitions = FeatureAliasDefinitions,
> = Readonly<
  {
    [K in keyof TAliases]: FeatureActionsFor<TAliases[K]>;
  }
>;

export type FeatureContentHandle = Readonly<{
  resolver: Pick<ContentResolver, "getMany">;
  /** Runtime-native progressive content production. Creates no graph state. */
  stream?: ContentStreamRuntime;
  /** Protected workflow body authority. Not exposed on application content scope. */
  bodies?: BodyStore;
  materialize(
    input: DurableContentInput,
    options?: { origin?: AssetOrigin },
  ): Promise<ContentSequence>;
  linkOwner(ownerId: string, content: ContentSequence): Promise<void>;
}>;

export type FeatureTransactionOptions = Readonly<{
  operationKey?: string;
  identity?: FeatureOperationIdentity & {
    metadata?: CollectionWriteOptions["identity"] extends infer I
      ? I extends { metadata?: infer M } ? M : never
      : never;
  };
  signal?: AbortSignal;
}>;

export type FeatureTransactionContext = Readonly<{
  collections: ScopedCollections;
  collection<
    D extends {
      readonly name: string;
      readonly $inferSelect?: unknown;
      readonly $inferInsert?: unknown;
    },
  >(
    definition: D,
  ): ScopedCollectionFor<D>;
  relations: Readonly<{
    upsert(
      input: Omit<ProjectDomainRelationInput, "namespace">,
    ): Promise<DomainRelation>;
  }>;
}>;

export type FeatureContextServices =
  & FeatureContextValues
  & Readonly<{
    namespace: string;
    operationKey?: string;
    now(): Date;
    events: Readonly<{
      list(options?: {
        threadId?: string;
        correlationId?: string;
        afterPosition?: string;
        limit?: number;
      }): Promise<readonly DurableEvent[]>;
    }>;
    deliveries: Readonly<{
      list(options?: {
        eventId?: string;
        consumerId?: string;
        status?: EventDelivery["status"];
        limit?: number;
      }): Promise<readonly EventDelivery[]>;
    }>;
    relations: Readonly<{
      list(
        options?: Omit<ListDomainRelationsOptions, "namespace">,
      ): Promise<readonly DomainRelation[]>;
    }>;
    signal?: AbortSignal;
    collection<
      D extends {
        readonly name: string;
        readonly $inferSelect?: unknown;
        readonly $inferInsert?: unknown;
      },
    >(
      definition: D,
    ): ScopedCollectionFor<D>;
    transaction<T>(
      execute: (context: FeatureTransactionContext) => T | Promise<T>,
      options?: FeatureTransactionOptions,
    ): Promise<T>;
  }>;

/** Host context built from engine primitives. Not an action execute context. */
export type FeatureHostContext =
  & FeatureContextServices
  & Readonly<{
    collections: ScopedCollections;
    content: FeatureContentHandle;
    features: FeatureInvoker;
    feature<F extends AnyFeatureDefinition>(
      definition: F,
    ): FeatureActionsFor<F>;
  }>;

/** Execute context for one Feature action. */
export type FeatureExecuteContext =
  & FeatureContextServices
  & Readonly<{
    collections: ScopedCollections;
    features: FeatureInvoker;
    feature<F extends AnyFeatureDefinition>(
      definition: F,
    ): FeatureActionsFor<F>;
    content: FeatureContentHandle;
  }>;

/** Same primitives as Feature actions. No application god-object. No registry. */
export type FeatureContext = FeatureExecuteContext;

export type FeatureAction<
  S extends JsonSchema | undefined = undefined,
  TOutput = unknown,
  O extends JsonSchema | undefined = undefined,
> = Readonly<{
  inputSchema?: S;
  outputSchema?: O;
  execute(
    input: FeatureSchemaInput<S>,
    context: FeatureExecuteContext,
  ): TOutput | Promise<TOutput>;
}>;

export type FeatureActionFunction<TOutput = unknown> = (
  input: unknown,
  context: FeatureExecuteContext,
) => TOutput | Promise<TOutput>;

export type ErasedFeatureAction = Readonly<{
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  execute(
    input: unknown,
    context: FeatureExecuteContext,
  ): unknown;
}>;

export type FeatureActionInput = ErasedFeatureAction | FeatureActionFunction;

export type FeatureActionMap = Readonly<Record<string, FeatureActionInput>>;

export type NormalizedFeatureActionMap = Readonly<
  Record<string, ErasedFeatureAction>
>;

export type FeatureDefinition<
  TActions extends Readonly<Record<string, FeatureActionInput>> =
    NormalizedFeatureActionMap,
> = Readonly<{
  id: string;
  actions: TActions;
}>;

export type AnyFeatureDefinition = FeatureDefinition<
  NormalizedFeatureActionMap
>;

/** @deprecated Use FeatureDefinition. Kept as the registry resource type name. */
export type FeatureResource = AnyFeatureDefinition;

export type FeatureContextBindings = Readonly<{
  namespace: string;
  plugins: PluginRegistry;
  collections?: {
    withScope(scope: { namespace: string }): ScopedCollections;
  };
  collectionRuntime: CollectionRuntime;
  transaction?: CollectionRuntime["transaction"];
  now?: () => Date;
  /** Consumer-local Feature aliases. Never derived from a global Feature field. */
  featureAliases?: Readonly<Record<string, AnyFeatureDefinition>>;
  contentResolver: Pick<ContentResolver, "getMany">;
  content?: (namespace: string) => FeatureContentHandle;
  events: {
    list(options: {
      namespace: string;
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
  };
  deliveries: {
    list(options: {
      namespace: string;
      eventId?: string;
      consumerId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
  };
  relations: {
    list(
      options: ListDomainRelationsOptions,
    ): Promise<readonly DomainRelation[]>;
    upsert?(
      input: ProjectDomainRelationInput,
    ): Promise<DomainRelation>;
  };
}>;
