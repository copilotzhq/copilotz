import { withoutCollectionPolicyInvocation } from "../collections/policy-invocation.ts";
import { withoutOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import { assertEventCommitted } from "./store.ts";
import type {
  DeliveryDispatchFailure,
  DeliveryExecutionHandle,
  DeliveryExecutor,
  DeliveryRecoveryDispatch,
} from "../execution/types.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import type {
  CommitEventMutationOptions,
  CommitEventMutationResult,
  EventStore,
} from "./store.ts";
import type { CopilotzEvent, DurableEventDraft } from "./types.ts";

export type CoordinatedMutationOptions<T> =
  & Omit<
    CommitEventMutationOptions<T>,
    "consumers"
  >
  & Readonly<{
    /** When false, leave publication to flushCommitted after the outer commit.
     * Joined transactions always defer publication, regardless of this option. */
    dispatch?: boolean;
    /** Prepared JSON body used for precommit matching. Not persisted. */
    matchData?: unknown;
  }>;

export type EventDispatchReport = Readonly<{
  handles: readonly DeliveryExecutionHandle[];
  failures: readonly DeliveryDispatchFailure[];
}>;

const EMPTY_DISPATCH: EventDispatchReport = {
  handles: [] as const,
  failures: [] as const,
} as const;

export type CoordinatedMutationResult<T> =
  & CommitEventMutationResult<T>
  & Readonly<{
    dispatch: EventDispatchReport;
    publishError?: unknown;
  }>;

export type EventPublisher = (
  event: CopilotzEvent,
  context?: Readonly<{
    databaseSchema?: string;
    settlementScopeId?: string;
    actionScopeId?: string;
  }>,
) => void | Promise<void>;

export type CreateEventCoordinatorOptions = Readonly<{
  store: EventStore;
  registry: PluginRegistry;
  executor: DeliveryExecutor;
  publish?: EventPublisher;
  onDispatchFailure?: (failure: DeliveryDispatchFailure) => void;
}>;

export type EventCoordinator = Readonly<{
  commitMutation<T>(
    options: CoordinatedMutationOptions<T>,
  ): Promise<CoordinatedMutationResult<T>>;
  flushCommitted(
    result: CommitEventMutationResult<unknown>,
  ): Promise<EventDispatchReport>;
  append(
    draft: DurableEventDraft,
    options?: { maxAttempts?: number },
  ): Promise<CoordinatedMutationResult<void>>;
  recover(options?: {
    databaseSchema?: string;
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
}>;

/** Coordinates the post-commit publication and Oxian dispatch boundary. */
export function createEventCoordinator(
  options: CreateEventCoordinatorOptions,
): EventCoordinator {
  const reportFailure = (failure: DeliveryDispatchFailure): void => {
    try {
      options.onDispatchFailure?.(failure);
    } catch {
      // Observability callbacks cannot change already committed domain state.
    }
  };

  const dispatch = async (
    result: CommitEventMutationResult<unknown>,
  ): Promise<EventDispatchReport> => {
    const actionable = result.deliveries.filter((delivery) =>
      delivery.status === "pending"
    );
    // A processor may commit another event while occupying the only embedded
    // worker slot. Placement must not be awaited in that call stack: the
    // durable delivery is already the recovery contract and starts as soon as
    // the current worker yields its slot.
    const workerOriginated = [
      result.event.metadata.sourceDeliveryId,
      result.event.metadata.sourceStreamId,
      result.event.metadata.sourceLiveDispatchId,
    ].some((value) => typeof value === "string" && value.trim().length > 0) ||
      result.event.metadata.sourceOwnerAlarm === true;
    if (workerOriginated) {
      for (const delivery of actionable) {
        options.executor.scheduleDelivery(delivery);
      }
      return ({
        handles: [] as const,
        failures: [] as const,
      } as const);
    }
    const settled = await Promise.allSettled(
      actionable.map((delivery) => options.executor.dispatchDelivery(delivery)),
    );
    const handles: DeliveryExecutionHandle[] = [];
    const failures: DeliveryDispatchFailure[] = [];
    settled.forEach((item, index) => {
      if (item.status === "fulfilled") {
        handles.push(item.value);
        return;
      }
      const failure = {
        deliveryId: actionable[index].id,
        error: item.reason,
      } as const;
      failures.push(failure);
      reportFailure(failure);
      // Placement did not claim the delivery. Retry through the local queue,
      // which wakes when capacity frees, instead of waiting for recovery's
      // next persisted deadline (possibly an unrelated active lease).
      try {
        options.executor.scheduleDelivery(actionable[index]);
      } catch {
        // The executor is shutting down. The delivery is already durable and
        // recovery remains its contract; never fail the committed event here.
      }
    });
    return ({
      handles: handles,
      failures: failures,
    } as const);
  };

  const publications = new WeakMap<
    CopilotzEvent,
    Promise<Readonly<{ dispatch: EventDispatchReport; publishError?: unknown }>>
  >();
  const publishCommitted = (
    result: CommitEventMutationResult<unknown>,
  ) => {
    assertEventCommitted(result.event);
    const existing = publications.get(result.event);
    if (existing) return existing;
    // Install the promise before invoking user publication callbacks, which
    // may reenter the coordinator. Repeated flushes share one publication.
    const pending = Promise.resolve().then(() =>
      withoutCollectionPolicyInvocation(() =>
        withoutOwnerCommandAuthorization(async () => {
          let publishError: unknown;
          if (!result.deduplicated) {
            try {
              await options.publish?.(result.event, {
                settlementScopeId: result.settlementScopeId,
                actionScopeId: result.actionScopeId,
              });
            } catch (error) {
              publishError = error;
            }
          }
          return {
            dispatch: await dispatch(result),
            ...(publishError === undefined ? {} : { publishError }),
          };
        })
      )
    );
    publications.set(result.event, pending);
    return pending;
  };

  const commitMutation = async <T>(
    mutation: CoordinatedMutationOptions<T>,
  ): Promise<CoordinatedMutationResult<T>> => {
    // Durable filters are synchronous so the complete obligation set is known
    // before entering the database transaction.
    const enableDispatch = mutation.transaction === undefined &&
      mutation.dispatch !== false;
    const consumers = options.registry.durableConsumers(
      mutation.draft,
      mutation.matchData,
    );
    const committed = await options.store.commitMutation({
      draft: mutation.draft,
      eventId: mutation.eventId,
      ingress: mutation.ingress,
      body: mutation.body,
      statement: mutation.statement,
      mutate: mutation.mutate,
      recoverDuplicate: mutation.recoverDuplicate,
      maxAttempts: mutation.maxAttempts,
      transaction: mutation.transaction,
      admission: mutation.admission,
      consumers,
    });

    if (!enableDispatch) {
      return ({
        ...committed,
        dispatch: EMPTY_DISPATCH,
      } as const);
    }
    return { ...committed, ...await publishCommitted(committed) };
  };

  const flushCommitted = async (
    result: CommitEventMutationResult<unknown>,
  ): Promise<EventDispatchReport> => (await publishCommitted(result)).dispatch;

  return ({
    commitMutation,
    flushCommitted,
    append(draft, appendOptions = {}) {
      return commitMutation({
        draft,
        maxAttempts: appendOptions.maxAttempts,
      });
    },
    recover(recoveryOptions = {}) {
      return options.executor.dispatchRecoverable({
        ...recoveryOptions,
        databaseSchema: recoveryOptions.databaseSchema ??
          options.store.databaseSchema,
      });
    },
  } as const);
}
