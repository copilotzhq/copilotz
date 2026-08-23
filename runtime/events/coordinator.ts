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
    /** When false, insert deliveries but do not publish or dispatch yet. */
    dispatch?: boolean;
    /** Prepared JSON body used for precommit matching. Not persisted. */
    matchData?: unknown;
  }>;

export type EventDispatchReport = Readonly<{
  handles: readonly DeliveryExecutionHandle[];
  failures: readonly DeliveryDispatchFailure[];
}>;

const EMPTY_DISPATCH: EventDispatchReport = Object.freeze({
  handles: Object.freeze([]),
  failures: Object.freeze([]),
});

export type CoordinatedMutationResult<T> =
  & CommitEventMutationResult<T>
  & Readonly<{
    dispatch: EventDispatchReport;
    publishError?: unknown;
  }>;

export type EventPublisher = (
  event: CopilotzEvent,
  context?: Readonly<{ settlementScopeId: string }>,
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
    options?: { priority?: number; maxAttempts?: number },
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
    ].some((value) => typeof value === "string" && value.trim().length > 0);
    if (workerOriginated) {
      for (const delivery of actionable) {
        options.executor.scheduleDelivery(delivery);
      }
      return Object.freeze({
        handles: Object.freeze([]),
        failures: Object.freeze([]),
      });
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
      const failure = Object.freeze({
        deliveryId: actionable[index].id,
        error: item.reason,
      });
      failures.push(failure);
      reportFailure(failure);
    });
    return Object.freeze({
      handles: Object.freeze(handles),
      failures: Object.freeze(failures),
    });
  };

  const commitMutation = async <T>(
    mutation: CoordinatedMutationOptions<T>,
  ): Promise<CoordinatedMutationResult<T>> => {
    // Durable filters are synchronous so the complete obligation set is known
    // before entering the database transaction.
    const enableDispatch = mutation.dispatch !== false;
    const consumers = options.registry.durableConsumers(
      mutation.draft,
      mutation.matchData,
    );
    const committed = await options.store.commitMutation({
      draft: mutation.draft,
      mutate: mutation.mutate,
      recoverDuplicate: mutation.recoverDuplicate,
      priority: mutation.priority,
      maxAttempts: mutation.maxAttempts,
      transaction: mutation.transaction,
      consumers,
    });

    if (!enableDispatch) {
      return Object.freeze({
        ...committed,
        dispatch: EMPTY_DISPATCH,
      });
    }
    let publishError: unknown;
    if (!committed.deduplicated) {
      try {
        await options.publish?.(committed.event, {
          settlementScopeId: committed.settlementScopeId,
        });
      } catch (error) {
        publishError = error;
      }
    }
    const dispatched = await dispatch(committed);
    return Object.freeze({
      ...committed,
      dispatch: dispatched,
      ...(publishError === undefined ? {} : { publishError }),
    });
  };

  const flushCommitted = async (
    result: CommitEventMutationResult<unknown>,
  ): Promise<EventDispatchReport> => {
    if (result.deduplicated) return EMPTY_DISPATCH;
    try {
      await options.publish?.(result.event, {
        settlementScopeId: result.settlementScopeId,
      });
    } catch {
      // Publication cannot roll back already committed domain state.
    }
    return await dispatch(result);
  };

  return Object.freeze({
    commitMutation,
    flushCommitted,
    append(draft, appendOptions = {}) {
      return commitMutation({
        draft,
        priority: appendOptions.priority,
        maxAttempts: appendOptions.maxAttempts,
        mutate: () => Promise.resolve(undefined),
        recoverDuplicate: () => Promise.resolve(undefined),
      });
    },
    recover(recoveryOptions = {}) {
      return options.executor.dispatchRecoverable({
        ...recoveryOptions,
        databaseSchema: recoveryOptions.databaseSchema ??
          options.store.databaseSchema,
      });
    },
  });
}
