import type { CollectionPredicate } from "./predicate.ts";
import type {
  EventBodyRef,
  EventDelivery,
  EventDispatchReport,
  EventSubject,
} from "../events/index.ts";
import type { AssetManifestEntry } from "../content/index.ts";

export type CollectionEventOperation = "create" | "update" | "delete";

/** State-independent call intent persisted for safe transaction retries. */
export type CollectionMutationIntent =
  | Readonly<{ operation: "create"; input: unknown }>
  | Readonly<{
    operation: "update";
    id: string;
    set: unknown;
    unset: readonly string[];
  }>
  | Readonly<{
    operation: "command";
    id: string;
    name: string;
    input: unknown;
  }>
  | Readonly<{ operation: "delete"; id: string }>;

export type CollectionCreated<TRecord> = Readonly<{
  operation: "create";
  intent: CollectionMutationIntent;
  record: TRecord;
  assets: readonly AssetManifestEntry[];
}>;

export type CollectionUpdated<TRecord> = Readonly<{
  operation: "update";
  intent: CollectionMutationIntent;
  id: string;
  set: Partial<TRecord>;
  unset: readonly string[];
  record: TRecord;
  assets: readonly AssetManifestEntry[];
}>;

export type CollectionDeleted<TRecord> = Readonly<{
  operation: "delete";
  intent: CollectionMutationIntent;
  id: string;
  record: TRecord;
  assets: readonly AssetManifestEntry[];
}>;

export type CollectionEventBody<TRecord> =
  | CollectionCreated<TRecord>
  | CollectionUpdated<TRecord>
  | CollectionDeleted<TRecord>;

/** Compact durable envelope used by the Phase 1 collection kernel. */
export type CollectionDurableEvent = Readonly<{
  id: string;
  position: string;
  schemaVersion: number;
  eventType: string;
  namespace: string;
  subject?: EventSubject;
  metadata: Readonly<Record<string, unknown>>;
  causationId?: string;
  correlationId: string;
  deduplicationId?: string;
  dataRef: EventBodyRef;
  createdAt: string;
}>;

export type CollectionMutationIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
  metadata?: Record<string, unknown>;
}>;

export type CollectionWriteOptions = Readonly<{
  namespace: string;
  identity?: CollectionMutationIdentity;
  metadata?: Record<string, unknown>;
  /** Optional atomic policy checks evaluated by the collection kernel. */
  condition?: Readonly<{
    current?: CollectionFilter;
    next?: CollectionFilter;
  }>;
}>;

export type CollectionUpdatePatch<TRecord> = Readonly<{
  set?: Partial<TRecord>;
  unset?: readonly string[];
}>;

export type CollectionMutation<TRecord> = Readonly<{
  record: TRecord;
  event: CollectionDurableEvent;
  settlementScopeId: string;
  deliveries: readonly EventDelivery[];
  dispatch: EventDispatchReport;
  deduplicated: boolean;
  noop?: false;
}>;

export type CollectionNoop<TRecord> = Readonly<{
  record: TRecord;
  noop: true;
}>;

export type CollectionWrite<TRecord> =
  | CollectionMutation<TRecord>
  | CollectionNoop<TRecord>;

export function isCollectionNoop<TRecord>(
  value: CollectionWrite<TRecord>,
): value is CollectionNoop<TRecord> {
  return value.noop === true;
}

export type CollectionQueryOrder = Readonly<{
  field: string;
  direction?: "asc" | "desc";
}>;

export type CollectionFilter = Readonly<{
  filter?: CollectionPredicate;
  where?: Readonly<Record<string, unknown>>;
  contains?: Readonly<Record<string, unknown>>;
  containsAny?: Readonly<Record<string, readonly unknown[]>>;
}>;

export type CollectionQuery = Readonly<{
  filter?: CollectionPredicate;
  /** Additional conjunctive predicates applied before cursor selection. */
  all?: readonly CollectionFilter[];
  contains?: Readonly<Record<string, unknown>>;
  containsAny?: Readonly<Record<string, readonly unknown[]>>;
  where?: Readonly<Record<string, unknown>>;
  order?: CollectionQueryOrder;
  after?: string;
  before?: string;
  limit?: number;
  include?: readonly string[];
  text?: string;
}>;

export type CollectionAggregateMetric = Readonly<{
  op: "count" | "sum" | "avg";
  /** count(field), sum, and avg consider only reported JSON numeric values. */
  field?: string;
  filter?: CollectionPredicate;
}>;
export type CollectionAggregateGroup =
  | string
  | Readonly<{
    field: string;
    interval: "hour" | "day" | "week";
  }>;
export type CollectionAggregateQuery = Readonly<{
  filter?: CollectionPredicate;
  /** Additional conjunctive filters, matching CollectionQuery.all semantics. */
  all?: readonly CollectionFilter[];
  where?: Readonly<Record<string, unknown>>;
  groupBy?: readonly CollectionAggregateGroup[];
  metrics: Readonly<Record<string, CollectionAggregateMetric>>;
  limit?: number;
}>;
export type CollectionAggregateRow = Readonly<
  Record<string, string | number | boolean | null>
>;

/** One graph edge connected to a record in a scoped Collection. */
export type CollectionGraphRelation = Readonly<{
  id: string;
  namespace: string;
  type: string;
  source: Readonly<{ type: string; id: string }>;
  target: Readonly<{ type: string; id: string }>;
  metadata: Readonly<Record<string, unknown>>;
  weight: number;
  createdAt: string;
}>;

/** Stable result returned while a transaction is still only a mutation plan. */
export type CollectionMutationRef = Readonly<{ id: string }>;

/** Runtime-neutral relation intent accepted by the transaction planner. */
export type GraphRelationUpsertInput = Readonly<{
  id?: string;
  type: string;
  source: Readonly<{ type: string; id: string }>;
  target: Readonly<{ type: string; id: string }>;
  metadata?: Readonly<Record<string, unknown>>;
  weight?: number;
}>;

export type GraphRelationIntent = Readonly<{
  id: string;
  type: string;
  source: Readonly<{ type: string; id: string }>;
  target: Readonly<{ type: string; id: string }>;
  metadata: Readonly<Record<string, unknown>>;
  weight: number;
}>;

/** Self-contained durable body for a generic relation mutation. */
export type GraphRelationEventBody = Readonly<{
  operation: "upsert";
  intent: GraphRelationIntent;
  relation: CollectionGraphRelation;
}>;

/** Generic graph traversal rooted in the Collection receiving the call. */
export type CollectionRelationQuery = Readonly<{
  id?: string;
  direction?: "in" | "out" | "both";
  types?: readonly string[];
  limit?: number;
}>;

export type CollectionRecord = Readonly<
  Record<string, unknown> & {
    id: string;
    namespace: string;
    createdAt: string;
    updatedAt: string;
  }
>;
