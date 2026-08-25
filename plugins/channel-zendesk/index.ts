/** Exposes the public Zendesk Channel plugin surface. @module */
export {
  createZendeskChannelAdapter,
  createZendeskTransport,
} from "./adapters/index.ts";
export { createZendeskChannelPlugin } from "./plugin.ts";
export { createZendeskChannelResource } from "./resources/index.ts";
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
} from "./internal/contracts.ts";
