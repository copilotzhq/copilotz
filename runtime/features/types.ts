import type { CollectionRuntime } from "../collections/index.ts";
import type {
  CollectionMutationIdentity,
  ScopedCollections,
} from "../collections/index.ts";
import type {
  AssetOrigin,
  ContentResolver,
  ContentSequence,
  DurableContentInput,
} from "../content/index.ts";
import type {
  DomainRelation,
  ListDomainRelationsOptions,
} from "../domain/index.ts";
import type { DurableEvent, EventDelivery } from "../events/index.ts";
import type {
  PluginRegistry,
  PluginResource,
  PluginResourceOrigin,
  PluginResourceType,
} from "../plugins/index.ts";

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

export type FeatureCallOptions = Readonly<{
  operationKey?: string;
  identity?: CollectionMutationIdentity;
}>;

export type FeatureActionInvoker = (
  input?: unknown,
  options?: FeatureCallOptions,
) => Promise<unknown>;

export type FeatureInvoker = Readonly<
  Record<string, Readonly<Record<string, FeatureActionInvoker>>>
>;

export type FeatureResources = Readonly<{
  list<T extends PluginResource = PluginResource>(
    type: PluginResourceType,
  ): readonly T[];
  get<T extends PluginResource = PluginResource>(
    type: PluginResourceType,
    id: string,
  ): T | undefined;
  require<T extends PluginResource = PluginResource>(
    type: PluginResourceType,
    id: string,
  ): T;
  origin(
    type: PluginResourceType,
    id: string,
  ): PluginResourceOrigin | undefined;
}>;

/** Same primitives as processors. No application god-object. No HTTP request. */
export type FeatureContext = Readonly<{
  namespace: string;
  collections: ScopedCollections;
  content: Readonly<{
    resolver: Pick<ContentResolver, "getMany">;
    materialize(
      input: DurableContentInput,
      options?: { origin?: AssetOrigin },
    ): Promise<ContentSequence>;
    linkOwner(ownerId: string, content: ContentSequence): Promise<void>;
  }>;
  resources: FeatureResources;
  features: FeatureInvoker;
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
}>;

export type FeatureAction = (
  input: unknown,
  context: FeatureContext,
) => unknown | Promise<unknown>;

/** Transport-neutral named command contributed by a plugin. */
export type FeatureResource = Readonly<{
  id: string;
  alias: string;
  /** Read actions do not open a write transaction. Defaults to `write`. */
  mode?: "read" | "write";
  actions: Readonly<Record<string, FeatureAction>>;
}>;

export type FeatureContextBindings = Readonly<{
  namespace: string;
  plugins: PluginRegistry;
  collections?: {
    withScope(scope: { namespace: string }): ScopedCollections;
  };
  collectionRuntime: CollectionRuntime;
  transaction?: CollectionRuntime["transaction"];
  contentResolver: Pick<ContentResolver, "getMany">;
  content?: (namespace: string) => FeatureContext["content"];
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
  };
}>;
