/** Compatibility family barrel for the Channel core and provider plugins. @module */

export * from "../channel-core/index.ts";
export {
  webChannelAdapter,
  webChannelPlugin,
  webChannelResource,
} from "../channel-web/index.ts";
export type {} from "../channel-web/index.ts";
export * from "../channel-whatsapp/index.ts";
export * from "../channel-zendesk/index.ts";
export * from "../channel-telegram/index.ts";
export * from "../channel-discord/index.ts";
