/**
 * Composes a configured Persistent Terminal Action and Tool Resource.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  createPersistentTerminalAction,
  type CreatePersistentTerminalToolsPluginOptions,
} from "./actions/index.ts";
import { createPersistentTerminalToolResource } from "./resources/index.ts";

/** Packages persistent terminal access without taking ownership of its service. */
export function createPersistentTerminalToolsPlugin(
  options: CreatePersistentTerminalToolsPluginOptions,
): CopilotzPlugin {
  if (!options?.terminal || typeof options.terminal.execute !== "function") {
    throw new TypeError("A persistent terminal service is required.");
  }
  const alias = options.toolId?.trim() || "persistent_terminal";
  const action = createPersistentTerminalAction(options, alias);
  const tool = createPersistentTerminalToolResource(alias, action);
  return definePlugin({
    id: options.id ?? "@copilotz/persistent-terminal-tools",
    version: options.version ?? "3.0.0",
    actions: { [alias]: action },
    resources: { tools: { [alias]: tool } },
  });
}
