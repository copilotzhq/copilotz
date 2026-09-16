/**
 * Exposes the Adapter and transport helpers owned by Discord Channel.
 *
 * @module
 */

export {
  createDiscordTransport,
  discordChannelAdapter,
  verifyDiscordSignature,
} from "./channels/discord/index.ts";
