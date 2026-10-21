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
    "consumers" | "onCommitted"
  >
  & Readonly<{
    /** Explicit runtime obligations for child/resume events. */
    consumers?: CommitEventMutationOptions<T>["consumers"];
    /** When false, return without waiting for the committed publication. */
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
  deferPublication?(publish: () => Promise<void>): Promise<void>;
}>;

export type EventCoordinator = Readonly<{
  commitMutation<T>(
    options: CoordinatedMutationOptions<T>,
  ): Promise<CoordinatedMutationResult<T>>;
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

/** Wait for publication already registered at the command's outer commit gate. */
export function awaitEventPublication(
  result: CommitEventMutationResult<unknown>,
): Promise<EventDispatchReport> {
  return result.publication ?? Promise.resolve(EMPTY_DISPATCH);
}

/** Coordinates the post-commit publication and Oxian dispatch boundary. */
export function createEventCoordinator(
  options: CreateEventCoordinatorOptions,
):
  & EventCoordinator
  & Readonly<{
    /** Stop placement; committed delivery obligations remain available to recovery. */
    close(): void;
  }> {
  let closed = false;
  const reportFailure = (failure: DeliveryDispatchFailure): void => {
    try {
      options.onDispatchFailure?.(failure);
    } catch {
      // Observability callbacks cannot change already committed domain state.
    }
  };

  const dispatch = async (
    result: CommitEventMutationResult<unknown>,
    remotePreclaim = false,
  ): Promise<EventDispatchReport> => {
    if (closed) return EMPTY_DISPATCH;
    const actionable = result.deliveries.filter((delivery) =>
      delivery.status === "pending" ||
      (delivery.status === "leased" && (!delivery.leaseExpiresAt ||
        (remotePreclaim && !result.deduplicated)))
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
        if (!closed) options.executor.scheduleDelivery(actionable[index]);
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

  const commitMutation = async <T>(
    mutation: CoordinatedMutationOptions<T>,
  ): Promise<CoordinatedMutationResult<T>> => {
    // Durable filters are synchronous so the complete obligation set is known
    // before entering the database transaction.
    const enableDispatch = mutation.transaction === undefined &&
      mutation.dispatch !== false;
    const consumers = mutation.consumers ?? options.registry.durableConsumers(
      mutation.draft,
      mutation.matchData,
    );
    const publication = Promise.withResolvers<EventDispatchReport>();
    void publication.promise.catch(() => undefined);
    let publishError: unknown;
    const committed = await options.store.commitMutation({
      async onCommitted(result) {
        const publish = async () => {
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
          try {
            publication.resolve(
              await dispatch(result, !!mutation.initialRemoteClaim),
            );
          } catch (error) {
            publication.reject(error);
          }
        };
        if (options.deferPublication) await options.deferPublication(publish);
        else await publish();
        await publication.promise;
      },
      draft: mutation.draft,
      eventId: mutation.eventId,
      ingress: mutation.ingress,
      initialLocalClaim: mutation.initialLocalClaim,
      initialRemoteClaim: mutation.initialRemoteClaim,
      body: mutation.body,
      collectionChange: mutation.collectionChange,
      statement: mutation.statement,
      mutate: mutation.mutate,
      recoverDuplicate: mutation.recoverDuplicate,
      replayMetadata: mutation.replayMetadata,
      maxAttempts: mutation.maxAttempts,
      transaction: mutation.transaction,
      admission: mutation.admission,
      consumers,
    });

    if (!enableDispatch) {
      return ({
        ...committed,
        publication: publication.promise,
        dispatch: EMPTY_DISPATCH,
      } as const);
    }
    return {
      ...committed,
      publication: publication.promise,
      dispatch: await publication.promise,
      ...(publishError === undefined ? {} : { publishError }),
    };
  };

  return ({
    close() {
      closed = true;
    },
    commitMutation,
    append(draft, appendOptions = {}) {
      return commitMutation({
        draft,
        maxAttempts: appendOptions.maxAttempts,
      });
    },
    recover(recoveryOptions = {}) {
      if (closed) return Promise.resolve(EMPTY_DISPATCH);
      return options.executor.dispatchRecoverable({
        ...recoveryOptions,
        databaseSchema: recoveryOptions.databaseSchema ??
          options.store.databaseSchema,
      });
    },
  } as const);
}
