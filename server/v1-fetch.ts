import type { CopilotzApplication } from "../runtime/application/index.ts";
import {
  createEventNativeApp,
  type CreateEventNativeAppOptions,
  type EventNativeApp,
  type EventNativeAppRequest,
} from "./event-native.ts";
import {
  createEventNativeFetchHandler,
  type CreateEventNativeFetchHandlerOptions,
  type EventNativeFetchHandler,
  projectEventNativeSseOutput,
} from "./fetch.ts";
import {
  createV1SseProjector,
  type CreateV1SseProjectorOptions,
} from "./v1-sse.ts";

export type CreateV1FetchHandlerOptions = Readonly<{
  /** Route prefix. Defaults to /v1. */
  basePath?: string;
  /** Event-native application assembly options. */
  appOptions?: CreateEventNativeAppOptions;
  /** Legacy uppercase SSE projection options. */
  sse?: CreateV1SseProjectorOptions;
  resolveContext?: CreateEventNativeFetchHandlerOptions["resolveContext"];
  responseHeaders?: CreateEventNativeFetchHandlerOptions["responseHeaders"];
  onError?: CreateEventNativeFetchHandlerOptions["onError"];
}>;

function mappedRequest(
  request: EventNativeAppRequest,
): EventNativeAppRequest {
  if (
    request.resource === "threads" && request.method === "GET" &&
    (request.path?.length ?? 0) === 0
  ) {
    const rawStatus = request.query?.status;
    const statuses = (Array.isArray(rawStatus) ? rawStatus : [rawStatus])
      .filter((status): status is string => typeof status === "string")
      .flatMap((status) => status.split(","))
      .map((status) => status.trim());
    if (statuses.includes("all")) {
      const { status: _legacyStatus, ...query } = request.query ?? {};
      return Object.freeze({
        ...request,
        query: Object.freeze(query),
      });
    }
  }
  if (request.resource === "providers") {
    return Object.freeze({ ...request, resource: "channels" });
  }
  if (request.resource === "admin") {
    return Object.freeze({
      ...request,
      resource: "features",
      path: Object.freeze(["admin", ...(request.path ?? [])]),
    });
  }
  return request;
}

function requestResource(
  request: Request,
  basePath: string,
): string | undefined {
  const route = new URL(request.url).pathname.split("/").filter(Boolean).map(
    decodeURIComponent,
  );
  const base = basePath.split("/").filter(Boolean).map(decodeURIComponent);
  if (base.some((part, index) => route[index] !== part)) return undefined;
  return route[base.length];
}

/**
 * Keeps v1 route aliases at the transport edge. The wrapped app continues to
 * expose and execute only the canonical event-native resource vocabulary.
 */
export function createV1RouteAdapter(app: EventNativeApp): EventNativeApp {
  return Object.freeze({
    resources: app.resources,
    handle: (request) => app.handle(mappedRequest(request)),
  });
}

/**
 * Creates the transitional v1 Fetch surface over a v3 application.
 *
 * `/v1/providers/*` maps to `/channels/*` and retains the explicit uppercase
 * compatibility projection. Canonical `/v1/channels/*` routes stream the
 * event-native vocabulary unchanged. `/v1/admin/*` maps to
 * `/features/admin/*`; all other route names pass through unchanged.
 */
export function createV1FetchHandler(
  application: CopilotzApplication,
  options: CreateV1FetchHandlerOptions = {},
): EventNativeFetchHandler {
  const app = createV1RouteAdapter(
    createEventNativeApp(application, options.appOptions),
  );
  const configuredBasePath = options.basePath ?? "/v1";
  const projectLegacySse = createV1SseProjector(application, options.sse);
  return createEventNativeFetchHandler(app, {
    basePath: configuredBasePath,
    resolveContext: options.resolveContext,
    responseHeaders: options.responseHeaders,
    onError: options.onError,
    projectSseOutput: (output, request) =>
      requestResource(request, configuredBasePath) === "providers"
        ? projectLegacySse(output, request)
        : projectEventNativeSseOutput(output),
    sseEventName: (value) =>
      value && typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : undefined,
  });
}
