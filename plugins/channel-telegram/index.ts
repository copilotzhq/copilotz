/**
 * Exposes the public Telegram Channel plugin surface.
 *
 * @module
 */

export {
  createTelegramChannelAdapter,
  createTelegramTransport,
} from "./adapters/index.ts";
export { createTelegramChannelPlugin } from "./plugin.ts";
export { createTelegramChannelResource } from "./resources/index.ts";
export type {
  CreateTelegramChannelAdapterOptions,
  CreateTelegramChannelPluginOptions,
  CreateTelegramChannelResourceOptions,
  TelegramActionPayload,
  TelegramConfig,
  TelegramConfigContext,
  TelegramConfigResolver,
  TelegramDelivery,
  TelegramMediaInput,
  TelegramMessage,
  TelegramTransport,
  TelegramUpdate,
  TelegramUser,
  TransformTelegramDelivery,
} from "./internal/contracts.ts";
