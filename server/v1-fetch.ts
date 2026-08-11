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
 * `/v1/providers/*` maps to `/channels/*`, `/v1/admin/*` maps to
 * `/features/admin/*`, and request-bound outputs use the explicit uppercase v1
 * SSE projection. All other route names pass through unchanged.
 */
export function createV1FetchHandler(
  application: CopilotzApplication,
  options: CreateV1FetchHandlerOptions = {},
): EventNativeFetchHandler {
  const app = createV1RouteAdapter(
    createEventNativeApp(application, options.appOptions),
  );
  return createEventNativeFetchHandler(app, {
    basePath: options.basePath ?? "/v1",
    resolveContext: options.resolveContext,
    responseHeaders: options.responseHeaders,
    onError: options.onError,
    projectSseOutput: createV1SseProjector(application, options.sse),
    sseEventName: (value) =>
      value && typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : undefined,
  });
}
