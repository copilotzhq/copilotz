/** Public names for generated plugin composition. @module */
import corePlugin from "./plugin.generated.ts";
import {
  coreCollectionActions,
  coreCollections,
  coreCollectionsPlugin,
} from "../core-collections/plugin.ts";
export { coreCollections, coreCollectionsPlugin, corePlugin };
export const CORE_PLUGIN_ID = "@copilotz/core";
export const CORE_PLUGIN_VERSION = "0.65.1";
export const coreActions = { ...coreCollectionActions, ...corePlugin.actions };
export const coreProcessors = {
  ...coreCollectionsPlugin.processors,
  ...corePlugin.processors,
};
export type CoreCollections = typeof coreCollections;
export type CoreActions = typeof coreActions;
export type CoreProcessors = typeof coreProcessors;
