import { hostDatabaseScopes } from "./host-commands.ts";
import {
  createOwnerCapabilityHost,
  type OwnerCapabilityHost,
} from "../execution/owner-capabilities.ts";
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorLifecycleCallbacks,
  type HypervisorOptions,
  type HypervisorTransport,
} from "../../dependencies/oxian-hypervisor.ts";
import type {
  DeliveryDispatcher,
  ExecutionWorkTarget,
} from "../execution/index.ts";
import {
  createCopilotzApplication,
  observeApplicationPersistence,
} from "./application.ts";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
  CopilotzApplication,
  CopilotzApplicationObservation,
  CreateCopilotzApplicationOptions,
  InternalCopilotzApplication,
} from "./types.ts";
import {
  type CopilotzPersistenceOptions,
  openCopilotzPersistence,
} from "@copilotz/copilotz/persistence";

type GatewayEngineOptions = Omit<
  NonNullable<CreateCopilotzApplicationOptions["engine"]>,
  "eventHub" | "execution"
>;

export type CreateCopilotzGatewayOptions =
  & Omit<
    CreateCopilotzApplicationOptions,
    "database" | "engine"
  >
  & CopilotzPersistenceOptions
  & Readonly<{
    /** Creates a Gateway-owned Hypervisor when no dispatcher is injected. */
    transports?: readonly HypervisorTransport[];
    /** Trusted host binding before recovery. The caller owns the returned dispatcher. */
    dispatcher?: (
      binding: Readonly<{
        workerCalls: NonNullable<HypervisorOptions["workerCalls"]>;
        lifecycle: NonNullable<HypervisorLifecycleCallbacks>;
      }>,
    ) => DeliveryDispatcher | Promise<DeliveryDispatcher>;
    target?: ExecutionWorkTarget;
    workloadTargets?: Readonly<Record<string, ExecutionWorkTarget>>;
    admit?: HypervisorOptions["admit"];
    assign?: HypervisorOptions["assign"];
    sessions?: HypervisorOptions["sessions"];
    signal?: AbortSignal;
    hypervisorConfig?: HypervisorOptions["config"];
    engine?: GatewayEngineOptions;
  }>;

type GatewayFetchFallback = (request: Request) => Promise<Response>;

/**
 * Private role authority. The package composition root projects this into the
 * public base application plus Fetch; runtime code never constructs server
 * routes or imports semantic server modules.
 */
export type InternalCopilotzGateway = Readonly<{
  application: InternalCopilotzApplication;
  /** Register with an application-owned Hypervisor before its workers connect. */
  workerCalls: NonNullable<HypervisorOptions["workerCalls"]>;
  workerLifecycle: HypervisorLifecycleCallbacks;
  transports: readonly HypervisorTransport[];
  hypervisor?: Hypervisor;
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
  hostCommands: CopilotzApplication["hostCommands"];
  actions: CopilotzApplication["actions"];
  collections: CopilotzApplication["collections"];
  attach: CopilotzApplication["attach"];
  operationStatus: CopilotzApplication["operationStatus"];
  listOperations: CopilotzApplication["listOperations"];
  operationCheckpoint: CopilotzApplication["operationCheckpoint"];
  cancelOperation: CopilotzApplication["cancelOperation"];
  maintenance: CopilotzApplication["maintenance"];
  observe(): CopilotzApplicationObservation;
  admit(): Promise<void>;
  installFetchFallback(fallback: GatewayFetchFallback): void;
  close(reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}>;

function uniqueTransport(): HypervisorTransport {
  return ({
    type: "in-process" as const,
    config: {
      topic: `copilotz.gateway.${crypto.randomUUID()}`,
    } as const,
  } as const);
}

async function settleAll(
  operations: readonly (() => void | Promise<void>)[],
  message: string,
): Promise<void> {
  const settled = await Promise.allSettled(
    operations.map((operation) => operation()),
  );
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

/** Creates the durable ingress/dispatch role without hosting plugin work. */
export async function createCopilotzGateway(
  options: CreateCopilotzGatewayOptions = {},
  lifecycle: HypervisorLifecycleCallbacks = {},
): Promise<InternalCopilotzGateway> {
  if (
    options.dispatcher !== undefined && typeof options.dispatcher !== "function"
  ) {
    throw new TypeError(
      "dispatcher must be a trusted worker-capability binding callback.",
    );
  }
  options.signal?.throwIfAborted();
  if (options.dispatcher && options.transports) {
    throw new TypeError("Configure either dispatcher or transports, not both.");
  }
  if (
    options.dispatcher &&
    (options.admit || options.assign || options.sessions ||
      options.hypervisorConfig)
  ) {
    throw new TypeError(
      "Injected dispatchers own admission, assignment, sessions, and Hypervisor configuration.",
    );
  }

  hostDatabaseScopes(
    options.databaseSchema ?? "public",
    options.databaseScopes,
    options.hostCommands,
  );
  const persistence = await openCopilotzPersistence(options);
  const transports = options.dispatcher
    ? ([] as const)
    : ([...(options.transports ?? [uniqueTransport()])] as const);
  let fetchFallback: GatewayFetchFallback = (_request) =>
    Promise.resolve(
      new Response("Copilotz Gateway is initializing.", { status: 503 }),
    );
  // The callbacks are registered before application recovery constructs the owner.
  let ownerCapabilities: OwnerCapabilityHost | undefined;
  let closed = false;
  const capabilitiesReady = Promise.withResolvers<void>();
  void capabilitiesReady.promise.catch(() => undefined);
  const workerCalls: NonNullable<HypervisorOptions["workerCalls"]> = {
    admit: (context) => {
      if (closed) throw new Error("Copilotz owner is closed.");
      return ownerCapabilities?.workerCalls.admit(context);
    },
    admitUnassigned: (context) => {
      if (closed) throw new Error("Copilotz owner is closed.");
      return ownerCapabilities?.workerCalls.admitUnassigned?.(context);
    },
    maxConcurrent: 1024,
    maxPerConnection: 128,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    timeoutMs: 120_000,
  };
  const workerLifecycle: HypervisorLifecycleCallbacks = {
    async onReady(event) {
      if (closed) throw new Error("Copilotz owner is closed.");
      if (!event.workerCalls) {
        throw new Error(
          "Copilotz workers require negotiated owner capabilities.",
        );
      }
      // Application construction does not wait for worker readiness. Once the
      // host is installed, recovery can route to this already-connected peer.
      await capabilitiesReady.promise;
      if (closed) throw new Error("Copilotz owner is closed.");
      await lifecycle.onReady?.(event);
    },
    async onDisconnect(event) {
      await ownerCapabilities?.lifecycle?.onDisconnect?.(event);
      await lifecycle.onDisconnect?.(event);
    },
    async onComplete(event) {
      await ownerCapabilities?.lifecycle?.onComplete?.(event);
      await lifecycle.onComplete?.(event);
    },
  };
  Object.freeze(workerCalls);
  Object.freeze(workerLifecycle);
  let hypervisor: Hypervisor | undefined;
  let application: InternalCopilotzApplication | undefined;

  try {
    const dispatcher = options.dispatcher
      ? await options.dispatcher(Object.freeze({
        workerCalls,
        lifecycle: workerLifecycle,
      }))
      : (hypervisor = createHypervisor({
        transports,
        workerCalls,
        admit: options.admit,
        assign: options.assign,
        sessions: options.sessions,
        signal: options.signal,
        config: options.hypervisorConfig,
        fallback: (request) => fetchFallback(request),
      }, { ...lifecycle, ...workerLifecycle }));
    options.signal?.throwIfAborted();
    if (!dispatcher || typeof dispatcher.dispatch !== "function") {
      throw new TypeError(
        "dispatcher callback must return a delivery dispatcher.",
      );
    }
    application = await createCopilotzApplication(
      {
        namespace: options.namespace,
        databaseSchema: options.databaseSchema,
        databaseScopes: options.databaseScopes,
        hostCommands: options.hostCommands,
        protectedActions: options.protectedActions,
        collectionPolicies: options.collectionPolicies,
        plugins: options.plugins,
        collections: options.collections,
        actions: options.actions,
        processors: options.processors,
        views: options.views,
        resources: options.resources,
        adapters: options.adapters,
        assets: options.assets,
        onDeliveryDiagnostic: options.onDeliveryDiagnostic,
        database: persistence.database,
        engine: {
          ...(options.engine ?? {}),
          execution: {
            dispatcher,
            target: options.target,
            workloadTargets: options.workloadTargets,
          },
        },
      },
      undefined,
      (engine) => {
        ownerCapabilities = createOwnerCapabilityHost({
          registry: engine.plugins,
          createWorkloads: engine.execution.createWorkerWorkloads,
          resolveAuthority: engine.execution.resolveAuthority,
          lookupReceipt: engine.execution.lookupReceipt,
        });
        capabilitiesReady.resolve();
      },
    );
    options.signal?.throwIfAborted();
  } catch (error) {
    closed = true;
    capabilitiesReady.reject(error);
    await ownerCapabilities?.close("copilotz_gateway_initialization_failed")
      .catch(() => undefined);
    await application?.shutdown("copilotz_gateway_initialization_failed").catch(
      () => undefined,
    );
    await settleAll([
      () => hypervisor?.shutdown("copilotz_gateway_initialization_failed"),
      () => persistence.close("copilotz_gateway_initialization_failed"),
    ], "Copilotz Gateway initialization cleanup failed.").catch(() =>
      undefined
    );
    throw error;
  }

  const stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
  );
  try {
    // Persistence listeners only receive future ready transitions. The
    // Gateway owns durable recovery, so it must also sweep an already-ready
    // database before serving work.
    await application.startRecovery();
    options.signal?.throwIfAborted();
  } catch (error) {
    closed = true;
    stopObservingPersistence();
    await ownerCapabilities!.close("copilotz_gateway_recovery_failed").catch(
      () => undefined,
    );
    await application.shutdown("copilotz_gateway_recovery_failed").catch(() =>
      undefined
    );
    await settleAll([
      () => hypervisor?.shutdown("copilotz_gateway_recovery_failed"),
      () => persistence.close("copilotz_gateway_recovery_failed"),
    ], "Copilotz Gateway recovery cleanup failed.").catch(() => undefined);
    throw error;
  }

  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason = "copilotz_gateway_shutdown"): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    closed = true;
    stopObservingPersistence();
    shutdownTask = (async () => {
      const failures: unknown[] = [];
      // Resource cleanup retains the database generation until it settles.
      for (
        const operation of [
          () => ownerCapabilities!.close(reason),
          () => application!.shutdown(reason),
          () => hypervisor?.shutdown(reason),
          () => persistence.close(reason),
        ]
      ) {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Copilotz Gateway shutdown failed.");
      }
    })();
    shutdownTask.catch(() => undefined);
    return shutdownTask;
  };

  return ({
    application,
    workerCalls,
    workerLifecycle,
    transports,
    ...(hypervisor ? { hypervisor } : {}),
    async send(input) {
      await persistence.recovery?.admit();
      return await application!.send(input);
    },
    hostCommands: application.hostCommands,
    actions: application.host.actions,
    collections: application.host.collections,
    attach: (input) => application!.attach(input),
    operationStatus: (input) => application!.operationStatus(input),
    listOperations: (input) => application!.listOperations(input),
    operationCheckpoint: (input) => application!.operationCheckpoint(input),
    cancelOperation: (input) => application!.cancelOperation(input),
    maintenance: (input) => application!.maintenance(input),
    observe: () => application!.observe(),
    admit: () => persistence.recovery?.admit() ?? Promise.resolve(),
    installFetchFallback(fallback) {
      fetchFallback = fallback;
    },
    close: shutdown,
    shutdown,
  } as const);
}
