/**
 * Exposes the public Telegram Channel plugin surface.
 *
 * @module
 */

export {
  createTelegramTransport,
  telegramChannelAdapter,
} from "./adapters/index.ts";
export { telegramChannelPlugin } from "./plugin.ts";
export { telegramChannelResource } from "./resources/index.ts";
export type {
  TelegramActionPayload,
  TelegramChannelOptions,
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
} from "./adapters/channels/telegram/contracts.ts";
