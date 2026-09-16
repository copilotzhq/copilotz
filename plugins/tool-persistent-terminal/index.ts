/**
 * Exposes the public Persistent Terminal Tools plugin surface.
 *
 * @module
 */

export { persistentTerminalToolsPlugin } from "./plugin.ts";
export type {
  PersistentTerminalAction,
  PersistentTerminalAsset,
  PersistentTerminalInput,
  PersistentTerminalPublishedAsset,
  PersistentTerminalScope,
  PersistentTerminalService,
  PersistentTerminalServiceContext,
} from "./actions/index.ts";

export * from "./resources/index.ts";
