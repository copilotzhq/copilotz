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
    /** Advanced app-owned placement. Copilotz never closes it. */
    dispatcher?: DeliveryDispatcher;
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
  transports: readonly HypervisorTransport[];
  hypervisor?: Hypervisor;
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
  observe(): CopilotzApplicationObservation;
  admit(): Promise<void>;
  installFetchFallback(fallback: GatewayFetchFallback): void;
  close(reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}>;

function uniqueTransport(): HypervisorTransport {
  return Object.freeze({
    type: "in-process" as const,
    config: Object.freeze({
      topic: `copilotz.gateway.${crypto.randomUUID()}`,
    }),
  });
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

  const persistence = await openCopilotzPersistence(options);
  const transports = options.dispatcher
    ? Object.freeze([])
    : Object.freeze([...(options.transports ?? [uniqueTransport()])]);
  let fetchFallback: GatewayFetchFallback = (_request) =>
    Promise.resolve(
      new Response("Copilotz Gateway is initializing.", { status: 503 }),
    );
  const hypervisor = options.dispatcher ? undefined : createHypervisor({
    transports,
    admit: options.admit,
    assign: options.assign,
    sessions: options.sessions,
    signal: options.signal,
    config: options.hypervisorConfig,
    fallback: (request) => fetchFallback(request),
  }, lifecycle);
  const dispatcher = options.dispatcher ?? hypervisor!;
  let application: InternalCopilotzApplication | undefined;

  try {
    application = await createCopilotzApplication({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      plugins: options.plugins,
      resources: options.resources,
      adapters: options.adapters,
      assets: options.assets,
      database: persistence.database,
      engine: {
        ...(options.engine ?? {}),
        execution: {
          dispatcher,
          target: options.target,
          workloadTargets: options.workloadTargets,
          continuousRecovery: true,
        },
      },
    });
  } catch (error) {
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
  } catch (error) {
    stopObservingPersistence();
    await settleAll([
      () => application!.shutdown("copilotz_gateway_recovery_failed"),
      () => hypervisor?.shutdown("copilotz_gateway_recovery_failed"),
      () => persistence.close("copilotz_gateway_recovery_failed"),
    ], "Copilotz Gateway recovery cleanup failed.").catch(() => undefined);
    throw error;
  }
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason = "copilotz_gateway_shutdown"): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    stopObservingPersistence();
    shutdownTask = settleAll([
      () => application!.shutdown(reason),
      () => hypervisor?.shutdown(reason),
      () => persistence.close(reason),
    ], "Copilotz Gateway shutdown failed.");
    shutdownTask.catch(() => undefined);
    return shutdownTask;
  };

  return Object.freeze({
    application,
    transports,
    ...(hypervisor ? { hypervisor } : {}),
    async send(input) {
      await persistence.recovery?.admit();
      return await application!.send(input);
    },
    observe: () => application!.observe(),
    admit: () => persistence.recovery?.admit() ?? Promise.resolve(),
    installFetchFallback(fallback) {
      fetchFallback = fallback;
    },
    close: shutdown,
    shutdown,
  });
}
