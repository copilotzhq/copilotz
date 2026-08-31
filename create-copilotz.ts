import { createEventNativeApp } from "./server/event-native.ts";
import type { CreateEventNativeAppOptions } from "./server/event-native.ts";
import {
  createEventNativeFetchHandler,
  type CreateEventNativeFetchHandlerOptions,
} from "./server/fetch.ts";
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

type EmbeddedOptions = RuntimeEmbeddedOptions & Readonly<{ role?: "embedded" }>;

type GatewayOptions =
  & RuntimeGatewayOptions
  & Readonly<{
    role: "gateway";
    /** Fetch projection options installed at the package composition root. */
    http?: CreateEventNativeFetchHandlerOptions;
    /** Trusted authorization boundary for each request's physical schema. */
    resolveDatabaseSchema?:
      CreateEventNativeAppOptions["resolveDatabaseSchema"];
  }>;

type WorkerOptions = RuntimeWorkerOptions & Readonly<{ role: "worker" }>;

/** One discriminated factory contract for embedded, Gateway, and Worker roles. */
export type CreateCopilotzOptions =
  | EmbeddedOptions
  | GatewayOptions
  | WorkerOptions;

type GatewayApplication =
  & CopilotzApplication
  & Readonly<{
    fetch(request: Request): Promise<Response>;
  }>;

type WorkerFactoryResult = Readonly<{
  ready: Promise<void>;
  closed: Promise<void>;
  close(reason?: string): Promise<void>;
}>;

export function createCopilotz(
  options: GatewayOptions,
): Promise<GatewayApplication>;
export function createCopilotz(
  options: WorkerOptions,
): Promise<WorkerFactoryResult>;
export function createCopilotz(
  options?: EmbeddedOptions,
): Promise<CopilotzApplication>;
/** Composes exactly the plugins, resources, and adapters supplied by the caller. */
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
): Promise<CopilotzApplication | GatewayApplication | WorkerFactoryResult> {
  if (options.role === "worker") {
    const { role: _role, ...workerOptions } = options;
    const worker = await createWorker(workerOptions);
    return Object.freeze({
      ready: worker.ready.then(() => undefined),
      closed: worker.closed.then(() => undefined),
      close: (reason?: string) => worker.stop(reason),
    });
  }

  if (options.role === "gateway") {
    const {
      role: _role,
      http,
      resolveDatabaseSchema,
      ...gatewayOptions
    } = options;
    const gateway = await createGateway(gatewayOptions);
    try {
      const native = createEventNativeApp(gateway.application, {
        resolveDatabaseSchema,
      });
      const legacyFetch = createEventNativeFetchHandler(
        Object.freeze({
          resources: native.resources,
          async handle(request) {
            await gateway.admit();
            return await native.handle(request);
          },
        }),
        { basePath: "/v3", ...(http ?? {}) },
      );
      const hasServerFacade = Boolean(
        gateway.application.plugins.resources.server?.default,
      );
      const facadeFetch = hasServerFacade
        ? createServerFacadeFetchHandler(gateway.application, {
          admit: gateway.admit,
          resolveContext: http?.resolveContext,
          responseHeaders: http?.responseHeaders,
          onError: http?.onError,
        })
        : undefined;
      const fetch = facadeFetch
        ? async (request: Request): Promise<Response> => {
          const pathname = new URL(request.url).pathname.replace(/\/+$/, "") ||
            "/";
          const basePath = facadeFetch.routes.basePath;
          return pathname === basePath || pathname.startsWith(`${basePath}/`)
            ? await facadeFetch(request)
            : await legacyFetch(request);
        }
        : legacyFetch;
      gateway.installFetchFallback(fetch);
      return Object.freeze({
        send: gateway.send,
        attach: gateway.attach,
        operationStatus: gateway.operationStatus,
        listOperations: gateway.listOperations,
        operationCheckpoint: gateway.operationCheckpoint,
        cancelOperation: gateway.cancelOperation,
        maintenance: gateway.maintenance,
        observe: gateway.observe,
        close: gateway.close,
        fetch,
      });
    } catch (error) {
      await gateway.close("copilotz_gateway_initialization_failed").catch(() =>
        undefined
      );
      throw error;
    }
  }

  const { role: _role, ...embeddedOptions } = options;
  return await createEmbeddedCopilotz(embeddedOptions);
}
