import type { EventDelivery } from "../events/index.ts";
import { resolveProcessorEvent } from "../plugins/event-data.ts";
import type {
  CreateDeliveryWorkloadOptions,
  DeliveryContextBase,
  DeliveryDispatchMetadata,
  DeliveryWorkload,
  DeliveryWorkloadScheduler,
} from "./types.ts";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

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

function createDefaultScheduler(): DeliveryWorkloadScheduler {
  return Object.freeze({
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}

function requiredMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: keyof DeliveryDispatchMetadata,
): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
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
  return Object.freeze({
    schema,
    databaseSchema: requiredMetadataString(metadata, "databaseSchema"),
    deliveryId: requiredMetadataString(metadata, "deliveryId"),
    eventId: requiredMetadataString(metadata, "eventId"),
    consumerId: requiredMetadataString(metadata, "consumerId"),
    namespace: requiredMetadataString(metadata, "namespace"),
    dispatchAttemptId: requiredMetadataString(metadata, "dispatchAttemptId"),
    idempotencyKey: requiredMetadataString(metadata, "idempotencyKey"),
  });
}

function statusMetadata(
  deliveryId: string,
  status: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "copilotz.delivery.result.v1",
    deliveryId,
    status,
  });
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
    throw new TypeError("Delivery workload requires a store resolver.");
  }
  const leaseMs = boundedPositive(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
  const heartbeatMs = boundedPositive(
    options.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
    "heartbeatMs",
  );
  if (heartbeatMs >= leaseMs) {
    throw new TypeError("heartbeatMs must be less than leaseMs.");
  }
  const scheduler = options.scheduler ?? createDefaultScheduler();

  return async ({ metadata: rawMetadata, signal: dispatchSignal }) => {
    const metadata = parseDeliveryDispatchMetadata(rawMetadata);
    const store = options.resolveStore
      ? await options.resolveStore(metadata.databaseSchema)
      : options.store!;
    if (store.databaseSchema !== metadata.databaseSchema) {
      throw new TypeError("Delivery dispatch database schema mismatch.");
    }
    const delivery = await store.claimDelivery({
      id: metadata.deliveryId,
      owner: metadata.dispatchAttemptId,
      leaseMs,
    });
    if (!delivery) {
      const current = await store.getDelivery(metadata.deliveryId);
      return {
        metadata: statusMetadata(
          metadata.deliveryId,
          current?.status ?? "missing",
        ),
      };
    }

    const abort = new AbortController();
    const relayAbort = () => abort.abort(dispatchSignal.reason);
    if (dispatchSignal.aborted) relayAbort();
    else {
      dispatchSignal.addEventListener("abort", relayAbort, { once: true });
    }

    let heartbeatHandle: unknown;
    let heartbeatStopped = false;
    const stopHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatHandle !== undefined) scheduler.cancel(heartbeatHandle);
    };
    const heartbeat = () => {
      heartbeatHandle = scheduler.schedule(() => {
        void store.heartbeatDelivery({
          id: delivery.id,
          owner: metadata.dispatchAttemptId,
          leaseMs,
        }).then((renewed) => {
          if (!renewed) {
            abort.abort(new Error(`Delivery '${delivery.id}' lost its lease.`));
            return;
          }
          if (!heartbeatStopped) heartbeat();
        }).catch((error) => abort.abort(error));
      }, heartbeatMs);
    };
    heartbeat();

    try {
      const mismatch = deliveryMismatch(delivery, metadata);
      if (mismatch) {
        throw new TypeError(`Invalid delivery dispatch: ${mismatch}.`);
      }
      const event = await store.getEvent(delivery.eventId);
      if (!event) throw new Error(`Event '${delivery.eventId}' was not found.`);
      if (event.namespace !== metadata.namespace) {
        throw new TypeError("Invalid delivery dispatch: namespace mismatch.");
      }
      const processor = options.registry.processorForConsumer(
        delivery.consumerId,
      );
      if (!processor) {
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
          return Object.freeze({
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `delivery:${delivery.id}:${key}`,
            settlementScopeId: delivery.settlementScopeId,
            metadata: Object.freeze({
              ...structuredClone(mutationMetadata),
              sourceEventId: event.id,
              sourceDeliveryId: delivery.id,
              sourceConsumerId: delivery.consumerId,
            }),
          });
        };

      const base: DeliveryContextBase = Object.freeze({
        databaseSchema: metadata.databaseSchema,
        event,
        delivery,
        settlementScopeId: delivery.settlementScopeId,
        signal: abort.signal,
        idempotencyKey: delivery.id,
        dispatchAttemptId: metadata.dispatchAttemptId,
        createMutationIdentity,
      });
      const extension = await options.createContext?.(base);
      const context = Object.freeze({
        ...(extension ?? {}),
        ...base,
      });
      abort.signal.throwIfAborted();
      const processorEvent = await resolveProcessorEvent(store, event);
      const handle = processor.handle as (
        event: typeof processorEvent,
        executionContext: typeof context,
      ) => void | Promise<void>;
      await handle(processorEvent, context);
      abort.signal.throwIfAborted();
      const succeeded = await store.succeedDelivery(
        delivery.id,
        metadata.dispatchAttemptId,
      );
      if (!succeeded) {
        throw new Error(`Delivery '${delivery.id}' could not be settled.`);
      }
      return { metadata: statusMetadata(delivery.id, "succeeded") };
    } catch (error) {
      const failed = await store.failDelivery({
        id: delivery.id,
        owner: metadata.dispatchAttemptId,
        error,
      });
      const current = failed ?? await store.getDelivery(delivery.id);
      return {
        metadata: statusMetadata(
          delivery.id,
          current?.status ?? "missing",
        ),
      };
    } finally {
      stopHeartbeat();
      dispatchSignal.removeEventListener("abort", relayAbort);
    }
  };
}
