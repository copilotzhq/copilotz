/**
 * Exposes the public Persistent Terminal Tools plugin surface.
 *
 * @module
 */

export { createPersistentTerminalToolsPlugin } from "./plugin.ts";
export type {
  CreatePersistentTerminalToolsPluginOptions,
  PersistentTerminalAction,
  PersistentTerminalAsset,
  PersistentTerminalInput,
  PersistentTerminalPublishedAsset,
  PersistentTerminalScope,
  PersistentTerminalService,
  PersistentTerminalServiceContext,
} from "./actions/index.ts";
