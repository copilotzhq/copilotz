export {
  createZendeskChannelAdapter,
  createZendeskChannelPlugin,
  createZendeskChannelResource,
} from "./channel.ts";
export { createZendeskTransport } from "./transport.ts";
export type {
  CreateZendeskChannelAdapterOptions,
  CreateZendeskChannelPluginOptions,
  CreateZendeskChannelResourceOptions,
  TransformZendeskDelivery,
  ZendeskActionPayload,
  ZendeskConfig,
  ZendeskConfigContext,
  ZendeskConfigResolver,
  ZendeskDelivery,
  ZendeskMediaInput,
  ZendeskTransport,
  ZendeskWebhookPayload,
} from "./types.ts";
