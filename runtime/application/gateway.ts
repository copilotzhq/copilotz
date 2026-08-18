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
import { createEventNativeApp } from "../../server/event-native.ts";
import type { CreateEventNativeAppOptions } from "../../server/event-native.ts";
import {
  createEventNativeFetchHandler,
  type CreateEventNativeFetchHandlerOptions,
} from "../../server/fetch.ts";
import {
  createCopilotzApplication,
  observeApplicationPersistence,
} from "./application.ts";
import type {
  CopilotzApplication,
  CreateCopilotzApplicationOptions,
  InternalCopilotzApplication,
} from "./types.ts";
import {
  type CopilotzPersistenceOptions,
  openCopilotzPersistence,
} from "./persistence.ts";

type GatewayEngineOptions = Omit<
  NonNullable<CreateCopilotzApplicationOptions["engine"]>,
  "eventHub" | "execution"
>;

export type CopilotzGatewayHttpOptions = CreateEventNativeFetchHandlerOptions;

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
    http?: CopilotzGatewayHttpOptions;
    /** Authorizes and resolves the physical database schema for one request. */
    resolveDatabaseSchema?:
      CreateEventNativeAppOptions["resolveDatabaseSchema"];
  }>;

export type CopilotzGateway =
  & CopilotzApplication
  & Readonly<{
    role: "gateway";
    transports: readonly HypervisorTransport[];
    /** Present only when this Gateway created the Hypervisor. */
    hypervisor?: Hypervisor;
    /** Runtime-neutral application Fetch boundary. */
    fetch(request: Request): Promise<Response>;
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
): Promise<CopilotzGateway> {
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
  let fetchApplication = (_request: Request): Promise<Response> =>
    Promise.resolve(
      new Response("Copilotz Gateway is initializing.", {
        status: 503,
      }),
    );
  const hypervisor = options.dispatcher ? undefined : createHypervisor({
    transports,
    admit: options.admit,
    assign: options.assign,
    sessions: options.sessions,
    signal: options.signal,
    config: options.hypervisorConfig,
    fallback: (request) => fetchApplication(request),
  }, lifecycle);
  const dispatcher = options.dispatcher ?? hypervisor!;
  let application: InternalCopilotzApplication | undefined;

  try {
    application = await createCopilotzApplication({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      core: options.core,
      canonicalCore: options.canonicalCore,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      assets: options.assets,
      database: persistence.database,
      engine: {
        ...(options.engine ?? {}),
        execution: {
          dispatcher,
          target: options.target,
          workloadTargets: options.workloadTargets,
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

  const native = createEventNativeApp(application, {
    resolveDatabaseSchema: options.resolveDatabaseSchema,
  });
  fetchApplication = createEventNativeFetchHandler(
    Object.freeze({
      resources: native.resources,
      async handle(request) {
        await persistence.recovery?.admit();
        return await native.handle(request);
      },
    }),
    {
      basePath: "/v3",
      ...(options.http ?? {}),
    },
  );
  const stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
  );
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

  const {
    engine: _internalEngine,
    execution: _internalExecution,
    ...publicApplication
  } = application;

  return Object.freeze({
    ...publicApplication,
    config: Object.freeze({
      ...application.config,
      databaseOwnership: persistence.ownership,
    }),
    role: "gateway",
    transports,
    ...(hypervisor ? { hypervisor } : {}),
    async databaseScope(databaseSchema: string) {
      await persistence.recovery?.admit();
      return await application!.databaseScope(databaseSchema);
    },
    async connect(input: Parameters<CopilotzApplication["connect"]>[0]) {
      await persistence.recovery?.admit();
      return await application!.connect(input);
    },
    async run(input: Parameters<CopilotzApplication["run"]>[0]) {
      await persistence.recovery?.admit();
      return await application!.run(input);
    },
    async goal(input: Parameters<CopilotzApplication["goal"]>[0]) {
      await persistence.recovery?.admit();
      return await application!.goal(input);
    },
    fetch: (request: Request) => fetchApplication(request),
    shutdown,
  });
}
