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
  DeliveryWorkloadScheduler,
} from "./types.ts";
import {
  reportDeliveryDiagnostic,
  summarizeDeliveryError,
} from "./diagnostics.ts";

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
  return ({
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  } as const);
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
  const heartbeatMs = boundedPositive(
    options.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
    "heartbeatMs",
  );
  if (heartbeatMs >= leaseMs) {
    throw new TypeError("heartbeatMs must be less than leaseMs.");
  }
  const scheduler = options.scheduler ?? createDefaultScheduler();

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
    const delivery = await store.claimDelivery({
      id: metadata.deliveryId,
      owner: metadata.dispatchAttemptId,
      leaseMs,
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
      const settled = await store.succeedDelivery(
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
          delivery: JSON.parse(JSON.stringify(settled)),
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
      stopHeartbeat();
      dispatchSignal.removeEventListener("abort", relayAbort);
    }
  };

  // Each delivery reads through a view of its own; see read-view.ts.
  return async (call) => await readViews.run(async () => await deliver(call));
}

export type OwnerExecutionOptions = Readonly<{
  registry: import("../plugins/index.ts").PluginRegistry;
  publish: import("../engine/types.ts").RuntimeOutputPublisher;
  workerId: string;
  onDiagnostic?:
    import("./types.ts").CreateDeliveryWorkloadOptions["onDiagnostic"];
}>;
type OwnerExecutionFactory = (
  options: OwnerExecutionOptions,
) => Readonly<Record<string, DeliveryWorkload>>;
const executionHosts = new WeakMap<object, OwnerExecutionFactory>();
const injectedHosts = new Set<{
  factory: OwnerExecutionFactory;
  database: unknown;
  schema: string;
}>();
const transportHosts = new Map<
  string,
  Set<{ factory: OwnerExecutionFactory; database: unknown; schema: string }>
>();

/** Binds execution to the engine's existing schema capabilities, without opening storage. */
export function bindOwnerExecution(
  execution: object,
  factory: OwnerExecutionFactory,
): void {
  executionHosts.set(execution, factory);
}
function transportKey(transport: { type: string; config?: unknown }): string {
  const config = transport.config as {
    topic?: string;
    path?: string;
    url?: string | URL;
  };
  if (transport.type === "in-process" && config.topic) {
    return `in-process:${config.topic}`;
  }
  if (transport.type === "websocket") {
    const path = config.url ? new URL(config.url).pathname : config.path;
    if (path) return `websocket:${path}`;
  }
  throw new Error("Execution transport has no owner rendezvous identity.");
}
export function hostOwnerExecution(
  execution: object,
  transports: readonly { type: string; config?: unknown }[],
  database: unknown,
  schema: string,
): () => void {
  const factory = executionHosts.get(execution);
  if (!factory) throw new Error("Execution owner has not activated.");
  const injected = !transports.length && database !== undefined
    ? { factory, database, schema }
    : undefined;
  if (injected) injectedHosts.add(injected);
  const registrations = transports.map((transport) => {
    const key = transportKey(transport);
    const hosts = transportHosts.get(key) ?? new Set();
    const entry = { factory, database, schema };
    hosts.add(entry);
    transportHosts.set(key, hosts);
    return { key, hosts, entry };
  });
  return () => {
    if (injected) injectedHosts.delete(injected);
    for (const { key, hosts, entry } of registrations) {
      hosts.delete(entry);
      if (!hosts.size) transportHosts.delete(key);
    }
  };
}
export function connectOwnerExecution(
  transport: { type: string; config?: unknown },
  database: unknown,
  schema: string,
  options: OwnerExecutionOptions,
): Readonly<Record<string, DeliveryWorkload>> {
  const hosts = [...transportHosts.get(transportKey(transport)) ?? []];
  if (!hosts.length && database !== undefined) {
    hosts.push(
      ...[...injectedHosts].filter((host) =>
        host.database === database && host.schema === schema
      ),
    );
  }
  const matching = hosts.filter((host) => host.schema === schema).filter((
    host,
  ) =>
    transport.type === "websocket" || hosts.length > 1
      ? database !== undefined && host.database === database
      : true
  );
  if (matching.length !== 1) {
    throw new Error(
      "Worker requires one colocated execution owner. Cross-process owner capabilities require reverse-call transport support.",
    );
  }
  return matching[0].factory(options);
}
