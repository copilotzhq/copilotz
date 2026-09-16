/** Exposes the public Zendesk Channel plugin surface. @module */
export {
  createZendeskTransport,
  zendeskChannelAdapter,
} from "./adapters/index.ts";
export { zendeskChannelPlugin } from "./plugin.ts";
export { zendeskChannelResource } from "./resources/index.ts";
export type {
  TransformZendeskDelivery,
  ZendeskActionPayload,
  ZendeskChannelOptions,
  ZendeskConfig,
  ZendeskConfigContext,
  ZendeskConfigResolver,
  ZendeskDelivery,
  ZendeskMediaInput,
  ZendeskTransport,
  ZendeskWebhookPayload,
} from "./adapters/channels/zendesk/contracts.ts";
