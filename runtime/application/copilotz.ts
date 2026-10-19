import { withOwnedHosting } from "./hosting.ts";
import { hostDatabaseScopes } from "./database-scopes.ts";
import {
  createCopilotzApplication,
  observeApplicationPersistence,
} from "./application.ts";
import type {
  CreateCopilotzGatewayOptions,
  InternalCopilotzGateway,
} from "./gateway.ts";
import type { CopilotzPersistenceLifecycleCallbacks } from "@copilotz/copilotz/persistence";
import { openCopilotzPersistence } from "@copilotz/copilotz/persistence";
import type { CopilotzApplication } from "./types.ts";

type EmbeddedWorkerOptions = Readonly<{
  id?: string;
  capacity?: number;
}>;

export type CreateCopilotzOptions =
  & Omit<
    CreateCopilotzGatewayOptions,
    | "transports"
    | "dispatcher"
    | "target"
    | "workloadTargets"
    | "admit"
    | "assign"
    | "sessions"
    | "signal"
    | "hypervisorConfig"
    | "http"
    | "resolveDatabaseSchema"
  >
  & Readonly<{ worker?: EmbeddedWorkerOptions }>;

export type CopilotzEmbeddedApplication = CopilotzApplication;

/** Builds the embedded Gateway's Fetch handler; the caller owns HTTP policy. */
export type EmbeddedFetchFactory = (
  gateway: Pick<InternalCopilotzGateway, "application" | "admit">,
) => (request: Request) => Promise<Response>;

export type CopilotzEmbeddedFetchApplication =
  & CopilotzEmbeddedApplication
  & Readonly<{ fetch(request: Request): Promise<Response> }>;

/**
 * Creates the normal factory-first Copilotz application.
 *
 * With no database, Copilotz owns one private Ominipg connection. Injected
 * databases and execution infrastructure remain application-owned.
 */
export async function createCopilotz(
  options?: CreateCopilotzOptions,
  lifecycle?: CopilotzPersistenceLifecycleCallbacks,
): Promise<CopilotzEmbeddedApplication>;
export async function createCopilotz(
  options: CreateCopilotzOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks | undefined,
  createFetch: EmbeddedFetchFactory,
): Promise<CopilotzEmbeddedFetchApplication>;
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
  createFetch?: EmbeddedFetchFactory,
): Promise<CopilotzEmbeddedApplication | CopilotzEmbeddedFetchApplication> {
  options = { ...options, worker: options.worker && { ...options.worker } };
  hostDatabaseScopes(options.databaseScopes);
  const persistence = await openCopilotzPersistence(options, lifecycle);
  let application:
    | Awaited<ReturnType<typeof createCopilotzApplication>>
    | undefined;
  let fetch: ((request: Request) => Promise<Response>) | undefined;
  try {
    application = await createCopilotzApplication({
      ...options,
      database: undefined,
      databaseRecovery: undefined,
      databaseLifecycle: undefined,
      persistence,
      engine: {
        ...options.engine,
        execution: {
          workerId: options.worker?.id,
          capacity: options.worker?.capacity,
        },
      },
    });
    await application.startRecovery();
    fetch = createFetch?.({
      application,
      admit: () => persistence.recovery?.admit() ?? Promise.resolve(),
    });
  } catch (error) {
    await application?.shutdown("copilotz_embedded_initialization_failed")
      .catch(() => undefined);
    await persistence.close("copilotz_embedded_initialization_failed").catch(
      () => undefined,
    );
    throw error;
  }
  const stopObserving = observeApplicationPersistence(persistence, application);
  let closing: Promise<void> | undefined;
  return withOwnedHosting({
    send: application.send,
    actions: application.host.actions,
    collections: application.host.collections,
    attach: application.attach,
    operationStatus: application.operationStatus,
    listOperations: application.listOperations,
    operationCheckpoint: application.operationCheckpoint,
    cancelOperation: application.cancelOperation,
    maintenance: application.maintenance,
    observe: application.observe,
    close(reason) {
      return closing ??= (async () => {
        stopObserving();
        try {
          await application!.shutdown(reason);
        } finally {
          await persistence.close(reason);
        }
      })();
    },
    ...(fetch ? { fetch } : {}),
  }, undefined);
}
