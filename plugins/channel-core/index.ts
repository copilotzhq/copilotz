/** Shared Channel plugin public API. @module */

export * from "./actions/index.ts";
export * from "./authoring/index.ts";
export * from "./collections/index.ts";
export {
  CHANNELS_PLUGIN_ID,
  CHANNELS_PLUGIN_VERSION,
  channelsPlugin,
} from "./plugin.ts";
export * from "./processors/index.ts";
export * from "./internal/contracts.ts";
