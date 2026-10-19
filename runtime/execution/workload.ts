import { ACTION_CONTINUATION_CONSUMER } from "../actions/continuation-work.ts";
import type { EventDelivery } from "../events/index.ts";
import { isNonRetryableError } from "../failure.ts";
import { readViews } from "../collections/read-view.ts";
import { resolveProcessorEvent } from "../plugins/event-data.ts";
import type {
  CreateDeliveryWorkloadOptions,
  DeliveryContextBase,
  DeliveryDispatchMetadata,
  DeliveryWorkload,
} from "./types.ts";
import {
  reportDeliveryDiagnostic,
  summarizeDeliveryError,
} from "./diagnostics.ts";

const DEFAULT_LEASE_MS = 120_000;

function boundedPositive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function requiredMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: keyof DeliveryDispatchMetadata,
): string {
  const value = metadata[key];
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(`Delivery dispatch metadata requires '${key}'.`);
  }
  return value;
}

export function parseDeliveryDispatchMetadata(
  metadata: Readonly<Record<string, unknown>>,
): DeliveryDispatchMetadata {
  const schema = requiredMetadataString(metadata, "schema");
  if (schema !== "copilotz.delivery.dispatch.v1") {
    throw new TypeError(`Unsupported delivery dispatch schema '${schema}'.`);
  }
  if (
    !Number.isSafeInteger(metadata.ownerEpoch) ||
    Number(metadata.ownerEpoch) < 1
  ) {
    throw new TypeError(
      "Delivery dispatch metadata requires a positive owner epoch.",
    );
  }
  return ({
    schema,
    ownerEpoch: Number(metadata.ownerEpoch),
    databaseSchema: requiredMetadataString(metadata, "databaseSchema"),
    deliveryId: requiredMetadataString(metadata, "deliveryId"),
    eventId: requiredMetadataString(metadata, "eventId"),
    consumerId: requiredMetadataString(metadata, "consumerId"),
    namespace: requiredMetadataString(metadata, "namespace"),
    dispatchAttemptId: requiredMetadataString(metadata, "dispatchAttemptId"),
    idempotencyKey: requiredMetadataString(metadata, "idempotencyKey"),
  } as const);
}

function statusMetadata(
  deliveryId: string,
  status: string,
): Readonly<Record<string, string>> {
  return ({
    schema: "copilotz.delivery.result.v1",
    deliveryId,
    status,
  } as const);
}

function deliveryMismatch(
  delivery: EventDelivery,
  metadata: DeliveryDispatchMetadata,
): string | undefined {
  if (delivery.databaseSchema !== metadata.databaseSchema) {
    return "database schema mismatch";
  }
  if (delivery.eventId !== metadata.eventId) return "event ID mismatch";
  if (delivery.consumerId !== metadata.consumerId) {
    return "consumer ID mismatch";
  }
  if (metadata.idempotencyKey !== delivery.id) {
    return "idempotency key mismatch";
  }
  return undefined;
}

/** Creates the transport-neutral Oxian workload for one durable delivery. */
export function createDeliveryWorkload(
  options: CreateDeliveryWorkloadOptions,
): DeliveryWorkload {
  if (!options.store && !options.resolveStore) {
    throw new TypeError("Delivery workload requires a store continuation.");
  }
  const leaseMs = boundedPositive(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
  const deliver: DeliveryWorkload = async (
    { metadata: rawMetadata, signal: rawDispatchSignal },
  ) => {
    const metadata = parseDeliveryDispatchMetadata(rawMetadata);
    const store = options.resolveStore
      ? await options.resolveStore(metadata.databaseSchema)
      : options.store!;
    if (store.databaseSchema !== metadata.databaseSchema) {
      throw new TypeError("Delivery dispatch database schema mismatch.");
    }
    const authority = await store.executionAuthority();
    if (authority.epoch !== metadata.ownerEpoch) {
      throw new Error("Delivery dispatch belongs to a stale owner epoch.");
    }
    const dispatchSignal = AbortSignal.any([
      rawDispatchSignal,
      authority.signal,
    ]);
    dispatchSignal.throwIfAborted();
    const localClaim = options.localExecution &&
        metadata.consumerId === "processor:copilotz.server.action-request"
      ? await store.readLocalClaim(
        metadata.deliveryId,
        metadata.dispatchAttemptId,
      )
      : null;
    const delivery = localClaim ?? await store.claimDelivery({
      id: metadata.deliveryId,
      owner: metadata.dispatchAttemptId,
      leaseMs,
      ...(options.localExecution ? { localExecution: true } : {}),
    });
    if (!delivery) {
      const current = await store.getDelivery(metadata.deliveryId);
      reportDeliveryDiagnostic(options.onDiagnostic, {
        phase: "worker_claim_skipped",
        timestampMs: Date.now(),
        eventId: metadata.eventId,
        deliveryId: metadata.deliveryId,
        consumerId: metadata.consumerId,
        dispatchAttemptId: metadata.dispatchAttemptId,
        workerId: options.workerId,
        databaseSchema: metadata.databaseSchema,
        namespace: metadata.namespace,
        status: current?.status ?? "missing",
      });
      return {
        metadata: statusMetadata(
          metadata.deliveryId,
          current?.status ?? "missing",
        ),
      };
    }
    reportDeliveryDiagnostic(options.onDiagnostic, {
      phase: "worker_claimed",
      timestampMs: Date.now(),
      eventId: metadata.eventId,
      deliveryId: delivery.id,
      consumerId: metadata.consumerId,
      dispatchAttemptId: metadata.dispatchAttemptId,
      workerId: options.workerId,
      databaseSchema: metadata.databaseSchema,
      namespace: metadata.namespace,
      status: delivery.status,
    });

    const abort = new AbortController();
    const relayAbort = () => abort.abort(dispatchSignal.reason);
    if (dispatchSignal.aborted) relayAbort();
    else {
      dispatchSignal.addEventListener("abort", relayAbort, { once: true });
    }

    let untrackAttempt: (() => void) | undefined;

    try {
      const mismatch = deliveryMismatch(delivery, metadata);
      if (mismatch) {
        throw new TypeError(`Invalid delivery dispatch: ${mismatch}.`);
      }
      const event =
        options.resolvedEvent?.(metadata.databaseSchema, delivery.id) ??
          await store.getEvent(delivery.eventId);
      if (!event) throw new Error(`Event '${delivery.eventId}' was not found.`);
      if (event.namespace !== metadata.namespace) {
        throw new TypeError("Invalid delivery dispatch: namespace mismatch.");
      }
      if (!options.localExecution) {
        if (!options.trackAttempt) {
          throw new TypeError(
            "Remote delivery requires accepted session liveness.",
          );
        }
        untrackAttempt = options.trackAttempt({
          store,
          heartbeat: {
            id: delivery.id,
            owner: metadata.dispatchAttemptId,
            ownerEpoch: metadata.ownerEpoch,
            namespace: event.namespace,
            eventId: event.id,
            operationId: delivery.settlementScopeId,
            leaseMs,
          },
          signal: abort.signal,
          revoke: (reason) => abort.abort(reason),
        });
      }
      const continuation = delivery.consumerId === ACTION_CONTINUATION_CONSUMER
        ? options.executeContinuation
        : undefined;
      const processor = continuation
        ? undefined
        : options.registry.processorForConsumer(delivery.consumerId);
      if (!continuation && !processor) {
        throw new Error(
          `No processor is registered for consumer '${delivery.consumerId}'.`,
        );
      }

      const createMutationIdentity:
        DeliveryContextBase["createMutationIdentity"] = (
          operationKey,
          mutationMetadata = {},
        ) => {
          const key = operationKey.trim();
          if (!key) {
            throw new TypeError(
              "A delivery mutation operation key is required.",
            );
          }
          return ({
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `delivery:${delivery.id}:${key}`,
            settlementScopeId: delivery.settlementScopeId,
            actionScopeId: delivery.actionScopeId,
            deliveryLease: {
              deliveryId: delivery.id,
              owner: metadata.dispatchAttemptId,
            },
            metadata: {
              ...structuredClone(mutationMetadata),
              sourceEventId: event.id,
              sourceDeliveryId: delivery.id,
              sourceConsumerId: delivery.consumerId,
            } as const,
          } as const);
        };

      const base: DeliveryContextBase = {
        databaseSchema: metadata.databaseSchema,
        event,
        delivery,
        settlementScopeId: delivery.settlementScopeId,
        actionScopeId: delivery.actionScopeId,
        signal: abort.signal,
        idempotencyKey: delivery.id,
        dispatchAttemptId: metadata.dispatchAttemptId,
        createMutationIdentity,
      } as const;
      reportDeliveryDiagnostic(options.onDiagnostic, {
        phase: "worker_handler_started",
        timestampMs: Date.now(),
        eventId: event.id,
        deliveryId: delivery.id,
        consumerId: metadata.consumerId,
        dispatchAttemptId: metadata.dispatchAttemptId,
        workerId: options.workerId,
        databaseSchema: metadata.databaseSchema,
        namespace: metadata.namespace,
      });
      abort.signal.throwIfAborted();
      if (continuation) {
        await continuation(base);
      } else {
        const context = await options.createContext(base);
        abort.signal.throwIfAborted();
        const processorEvent = await resolveProcessorEvent(store, event, {
          getMany: (refs) => context.content.resolveMany(refs),
        });
        const handle = processor!.handle as (
          event: typeof processorEvent,
          executionContext: typeof context,
        ) => void | Promise<void>;
        try {
          await handle(processorEvent, context);
        } catch (error) {
          const onError = processor!.onError as (
            | ((
              error: unknown,
              event: typeof processorEvent,
              executionContext: typeof context,
            ) => boolean | Promise<boolean>)
            | undefined
          );
          const terminal = isNonRetryableError(error) ||
            delivery.attempts >= delivery.maxAttempts;
          if (
            abort.signal.aborted || !terminal ||
            !await onError?.(error, processorEvent, context)
          ) throw error;
        }
      }
      abort.signal.throwIfAborted();
      const current =
        delivery.consumerId === "processor:copilotz.server.action-request"
          ? await store.getDelivery(delivery.id)
          : null;
      const settled = current?.status === "succeeded"
        ? current
        : await store.succeedDelivery(
          delivery.id,
          metadata.dispatchAttemptId,
        );
      if (!settled) {
        throw new Error(`Delivery '${delivery.id}' could not be settled.`);
      }
      reportDeliveryDiagnostic(options.onDiagnostic, {
        phase: "worker_handler_settled",
        timestampMs: Date.now(),
        eventId: event.id,
        deliveryId: delivery.id,
        consumerId: metadata.consumerId,
        dispatchAttemptId: metadata.dispatchAttemptId,
        workerId: options.workerId,
        databaseSchema: metadata.databaseSchema,
        namespace: metadata.namespace,
        status: "succeeded",
      });
      // The settled row travels with the result, so the executor need not
      // read it back.
      return {
        metadata: {
          ...statusMetadata(delivery.id, "succeeded"),
          delivery:
            settled as unknown as import("../../dependencies/oxian-worker.ts").WorkerWorkContext[
              "metadata"
            ],
        },
      };
    } catch (error) {
      if (!abort.signal.aborted) abort.abort(error);
      const failed = await store.failDelivery({
        id: delivery.id,
        owner: metadata.dispatchAttemptId,
        error,
        retryable: !isNonRetryableError(error),
      });
      const current = failed ?? await store.getDelivery(delivery.id);
      reportDeliveryDiagnostic(options.onDiagnostic, {
        phase: "worker_handler_settled",
        timestampMs: Date.now(),
        eventId: metadata.eventId,
        deliveryId: delivery.id,
        consumerId: metadata.consumerId,
        dispatchAttemptId: metadata.dispatchAttemptId,
        workerId: options.workerId,
        databaseSchema: metadata.databaseSchema,
        namespace: metadata.namespace,
        status: current?.status ?? "missing",
        error: summarizeDeliveryError(error),
      });
      return {
        metadata: statusMetadata(
          delivery.id,
          current?.status ?? "missing",
        ),
      };
    } finally {
      if (!abort.signal.aborted) {
        abort.abort(new Error(`Delivery '${delivery.id}' execution ended.`));
      }
      untrackAttempt?.();
      dispatchSignal.removeEventListener("abort", relayAbort);
    }
  };

  // Each delivery reads through a view of its own; see read-view.ts.
  return async (call) => await readViews.run(async () => await deliver(call));
}

export type OwnerExecutionOptions = Readonly<{
  resolvedEvent?: (
    schema: string,
    id: string,
  ) => import("../events/types.ts").DurableEvent | undefined;
  registry: import("../plugins/index.ts").PluginRegistry;
  /** Trusted owner placement; never supplied by a worker. */
  localExecution?: boolean;
  trackAttempt?: import("./types.ts").DeliveryAttemptTracker;
  publish?: import("../engine/types.ts").RuntimeOutputPublisher;
  workerId: string;
  onDiagnostic?:
    import("./types.ts").CreateDeliveryWorkloadOptions["onDiagnostic"];
}>;
export type OwnerExecutionFactory = (
  options: OwnerExecutionOptions,
) => Readonly<Record<string, DeliveryWorkload>>;
