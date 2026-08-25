/** Exposes the public WhatsApp Channel plugin surface. @module */
export {
  createWhatsAppChannelAdapter,
  createWhatsAppGraphTransport,
  verifyWhatsAppSignature,
  whatsappHeader,
} from "./adapters/index.ts";
export {
  buildWhatsAppMediaCarouselMessage,
  buildWhatsAppReplyButtonsMessage,
  normalizeWhatsAppActionPayload,
  normalizeWhatsAppReplyButtons,
  resolveWhatsAppMediaCarouselAction,
  splitWhatsAppText,
} from "./authoring/index.ts";
export { createWhatsAppChannelPlugin } from "./plugin.ts";
export { createWhatsAppChannelResource } from "./resources/index.ts";
export type {
  CreateWhatsAppChannelAdapterOptions,
  CreateWhatsAppChannelPluginOptions,
  CreateWhatsAppChannelResourceOptions,
  TransformWhatsAppDelivery,
  WhatsAppActionPayload,
  WhatsAppCarouselImageInput,
  WhatsAppCarouselQuickReplyInput,
  WhatsAppConfig,
  WhatsAppConfigContext,
  WhatsAppConfigResolver,
  WhatsAppDelivery,
  WhatsAppDownloadedMedia,
  WhatsAppMediaCarouselAction,
  WhatsAppMediaCarouselCardInput,
  WhatsAppMediaInput,
  WhatsAppReplyButton,
  WhatsAppReplyButtonInput,
  WhatsAppResolvedCarouselCard,
  WhatsAppResolvedMediaCarouselAction,
  WhatsAppTransport,
  WhatsAppUploadedMedia,
  WhatsAppWebhookMessage,
  WhatsAppWebhookPayload,
} from "./internal/contracts.ts";
