import { withOwnedHosting } from "./runtime/application/hosting.ts";
import type { HostCommandDefinitions } from "./runtime/application/host-command-types.ts";
import { createServerFacadeFetchHandler } from "./server/facade.ts";
import { createCopilotz as createEmbeddedCopilotz } from "./runtime/application/copilotz.ts";
import type { CreateCopilotzOptions as RuntimeEmbeddedOptions } from "./runtime/application/copilotz.ts";
import {
  createCopilotzGateway as createGateway,
  createCopilotzWorker as createWorker,
} from "./runtime/application/index.ts";
import type {
  CreateCopilotzGatewayOptions as RuntimeGatewayOptions,
  CreateCopilotzWorkerOptions as RuntimeWorkerOptions,
} from "./runtime/application/index.ts";
import type { CopilotzApplication } from "./runtime/application/types.ts";
import type { RegistryComposition } from "./runtime/plugins/index.ts";
import type { InternalCopilotzGateway } from "./runtime/application/gateway.ts";

type EmbeddedOptions = RuntimeEmbeddedOptions & Readonly<{ role?: "embedded" }>;

type GatewayOptions =
  & RuntimeGatewayOptions
  & Readonly<{
    role: "gateway";
  }>;

type WorkerOptions = RuntimeWorkerOptions & Readonly<{ role: "worker" }>;

/** One discriminated factory contract for embedded, Gateway, and Worker roles. */
export type CreateCopilotzOptions =
  | EmbeddedOptions
  | GatewayOptions
  | WorkerOptions;

/** Reuse the registry's dependency and contribution composition at the public boundary. */
type CompositionOptions = Pick<
  RuntimeEmbeddedOptions,
  | "plugins"
  | "resources"
  | "adapters"
  | "actions"
  | "collections"
  | "processors"
  | "views"
>;
type CompositionOption<T, K extends keyof CompositionOptions, Fallback> =
  K extends keyof T ? NonNullable<T[K]> : Fallback;
type EmptyMap = Readonly<Record<never, never>>;
type ApplicationComposition<T extends CompositionOptions> = RegistryComposition<
  CompositionOption<T, "plugins", readonly []>,
  CompositionOption<T, "resources", EmptyMap>,
  CompositionOption<T, "adapters", EmptyMap>,
  CompositionOption<T, "actions", EmptyMap>,
  CompositionOption<T, "collections", EmptyMap>,
  CompositionOption<T, "processors", EmptyMap>,
  CompositionOption<T, "views", EmptyMap>
>;
type GatewayApplication<T extends CompositionOptions = CompositionOptions> =
  & CopilotzApplication<
    ApplicationComposition<T>["actions"],
    ApplicationComposition<T>["collections"],
    T extends { hostCommands: infer H extends HostCommandDefinitions } ? H
      : Readonly<Record<never, never>>
  >
  & Readonly<{
    fetch(request: Request): Promise<Response>;
  }>;

/** The embedded default serves the same `/api` facade as a Gateway. */
type EmbeddedApplication<T extends CompositionOptions = CompositionOptions> =
  GatewayApplication<T>;

type WorkerFactoryResult = Readonly<{
  ready: Promise<void>;
  closed: Promise<void>;
  close(reason?: string): Promise<void>;
}>;

/** The `/api` facade when `serverPlugin` is composed; otherwise 404. */
function serverFetch(
  gateway: InternalCopilotzGateway,
): (request: Request) => Promise<Response> {
  return gateway.application.plugins.resources.server?.default
    ? createServerFacadeFetchHandler(gateway.application, {
      admit: gateway.admit,
    })
    : (_request: Request) =>
      Promise.resolve(new Response(null, { status: 404 }));
}

export function createCopilotz<const T extends GatewayOptions>(
  options: T & GatewayOptions,
): Promise<GatewayApplication<T>>;
export function createCopilotz(
  options: WorkerOptions,
): Promise<WorkerFactoryResult>;
export function createCopilotz<const T extends EmbeddedOptions = EmptyMap>(
  options?: T & EmbeddedOptions,
): Promise<EmbeddedApplication<T>>;
/** Composes exactly the plugins, resources, and adapters supplied by the caller. */
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
): Promise<CopilotzApplication | GatewayApplication | WorkerFactoryResult> {
  if (options.role === "worker") {
    const { role: _role, ...workerOptions } = options;
    const worker = await createWorker(workerOptions);
    return ({
      ready: worker.ready.then(() => undefined),
      closed: worker.closed.then(() => undefined),
      close: (reason?: string) => worker.stop(reason),
    } as const);
  }

  if (options.role === "gateway") {
    const {
      role: _role,
      ...gatewayOptions
    } = options;
    const gateway = await createGateway(gatewayOptions);
    try {
      const fetch = serverFetch(gateway);
      gateway.installFetchFallback(fetch);
      return withOwnedHosting(
        {
          send: gateway.send,
          hostCommands: gateway.hostCommands,
          actions: gateway.actions,
          collections: gateway.collections,
          attach: gateway.attach,
          operationStatus: gateway.operationStatus,
          listOperations: gateway.listOperations,
          operationCheckpoint: gateway.operationCheckpoint,
          cancelOperation: gateway.cancelOperation,
          maintenance: gateway.maintenance,
          observe: gateway.observe,
          close: gateway.close,
          fetch,
        } as const,
        gateway.hypervisor,
      );
    } catch (error) {
      await gateway.close("copilotz_gateway_initialization_failed").catch(() =>
        undefined
      );
      throw error;
    }
  }

  const { role: _role, ...embeddedOptions } = options;
  return await createEmbeddedCopilotz(
    embeddedOptions,
    embeddedOptions.databaseLifecycle,
    (gateway) => serverFetch(gateway),
  );
}
