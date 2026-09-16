/**
 * Exposes the public Discord Channel plugin surface.
 *
 * @module
 */

export {
  createDiscordTransport,
  discordChannelAdapter,
  verifyDiscordSignature,
} from "./adapters/index.ts";
export { discordChannelPlugin } from "./plugin.ts";
export { discordChannelResource } from "./resources/index.ts";
export type {
  DiscordActionPayload,
  DiscordChannelOptions,
  DiscordConfig,
  DiscordConfigContext,
  DiscordConfigResolver,
  DiscordDelivery,
  DiscordInteraction,
  DiscordMediaInput,
  DiscordTransport,
  DiscordUser,
  TransformDiscordDelivery,
} from "./adapters/channels/discord/contracts.ts";
