/**
 * Exposes the public Web Channel plugin surface.
 *
 * @module
 */

export { createWebChannelAdapter } from "./adapters/index.ts";
export {
  createWebChannelPlugin,
  type CreateWebChannelPluginOptions,
} from "./plugin.ts";
export {
  createWebChannelResource,
  type CreateWebChannelResourceOptions,
} from "./resources/index.ts";
