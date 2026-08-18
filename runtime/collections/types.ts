import type { ContentRef } from "../content/index.ts";
import type {
  EventDelivery,
  EventDispatchReport,
  EventRouting,
  EventSubject,
  EventVisibility,
} from "../events/index.ts";

export type CollectionEventOperation = "create" | "update" | "delete";

export type CollectionCreated<TRecord> = Readonly<{
  operation: "create";
  record: TRecord;
}>;

export type CollectionUpdated<TRecord> = Readonly<{
  operation: "update";
  id: string;
  set: Partial<TRecord>;
  unset: readonly string[];
  record: TRecord;
}>;

export type CollectionDeleted<TRecord> = Readonly<{
  operation: "delete";
  id: string;
  record: TRecord;
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
  threadId?: string;
  subject?: EventSubject;
  routing: EventRouting;
  visibility: EventVisibility;
  metadata: Readonly<Record<string, unknown>>;
  causationId?: string;
  correlationId: string;
  deduplicationId?: string;
  dataRef: ContentRef;
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
  threadId?: string;
  routing?: EventRouting;
  visibility?: EventVisibility;
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

export type CollectionQuery = Readonly<{
  where?: Readonly<Record<string, unknown>>;
  order?: CollectionQueryOrder;
  after?: string;
  limit?: number;
  include?: readonly string[];
  text?: string;
}>;

export type CollectionRecord = Readonly<
  Record<string, unknown> & {
    id: string;
    namespace: string;
    createdAt: string;
    updatedAt: string;
  }
>;
