/**
 * Exposes the public Discord Channel plugin surface.
 *
 * @module
 */

export {
  createDiscordChannelAdapter,
  createDiscordTransport,
  verifyDiscordSignature,
} from "./adapters/index.ts";
export { createDiscordChannelPlugin } from "./plugin.ts";
export { createDiscordChannelResource } from "./resources/index.ts";
export type {
  CreateDiscordChannelAdapterOptions,
  CreateDiscordChannelPluginOptions,
  CreateDiscordChannelResourceOptions,
  DiscordActionPayload,
  DiscordConfig,
  DiscordConfigContext,
  DiscordConfigResolver,
  DiscordDelivery,
  DiscordInteraction,
  DiscordMediaInput,
  DiscordTransport,
  DiscordUser,
  TransformDiscordDelivery,
} from "./internal/contracts.ts";
