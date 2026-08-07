/** Runtime-neutral HTTP/application adapters for the event-native engine. */

export {
  createEventNativeApp,
  EVENT_NATIVE_OUTPUT_STREAM,
  isEventNativeOutputStream,
} from "./event-native.ts";
export type {
  CreateEventNativeAppOptions,
  EventNativeApp,
  EventNativeAppError,
  EventNativeAppRequest,
  EventNativeAppResponse,
  EventNativeFeatureContext,
  EventNativeFeatureResource,
  EventNativeOutputStream,
} from "./event-native.ts";

export { createEventNativeFetchHandler } from "./fetch.ts";
export type {
  CreateEventNativeFetchHandlerOptions,
  EventNativeFetchHandler,
  EventNativeSseProjector,
} from "./fetch.ts";

/** Compatibility transport projections over the v3 application model. */
export { createV1FetchHandler, createV1RouteAdapter } from "./v1-fetch.ts";
export type { CreateV1FetchHandlerOptions } from "./v1-fetch.ts";
export { createV1SseProjector } from "./v1-sse.ts";
export type {
  CreateV1SseProjectorOptions,
  V1SseAssetHrefInput,
} from "./v1-sse.ts";
