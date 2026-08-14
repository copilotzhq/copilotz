/** Compatibility projections for applications migrating from Copilotz v1. */
export { createV1FetchHandler } from "./v1-fetch.ts";
export type { CreateV1FetchHandlerOptions } from "./v1-fetch.ts";
export { createV1SseProjector } from "./v1-sse.ts";
export type {
  CreateV1SseProjectorOptions,
  V1SseAssetHrefInput,
} from "./v1-sse.ts";
export type {
  EventNativeHistoryInclude,
  EventNativeMessageHistoryIncluded,
  EventNativeResolvedContent,
} from "./history.ts";
