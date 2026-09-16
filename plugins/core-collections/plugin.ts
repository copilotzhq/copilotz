/** Public names for generated plugin composition. @module */
import coreCollectionsPlugin from "./plugin.generated.ts";
export { coreCollectionsPlugin };
export const coreCollections = coreCollectionsPlugin.collections;
export const coreCollectionActions = coreCollectionsPlugin.actions;
export type CoreCollections = typeof coreCollections;
export type CoreCollectionActions = typeof coreCollectionActions;
