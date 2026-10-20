/** Public names for generated Core composition. @module */
import corePlugin from "./plugin.generated.ts";
export { corePlugin };
export const CORE_PLUGIN_ID = "@copilotz/core";
export const CORE_PLUGIN_VERSION = "0.75.0";
export const coreActions: typeof corePlugin.actions = corePlugin.actions;
export const coreCollections: typeof corePlugin.collections =
  corePlugin.collections;
export const coreProcessors: typeof corePlugin.processors =
  corePlugin.processors;
export type CoreActions = typeof coreActions;
export type CoreCollections = typeof coreCollections;
export type CoreProcessors = typeof coreProcessors;
