/** Exposes the public WhatsApp Channel plugin surface. @module */
export {
  createWhatsAppGraphTransport,
  verifyWhatsAppSignature,
  whatsappChannelAdapter,
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
export { whatsappChannelPlugin } from "./plugin.ts";
export { whatsappChannelResource } from "./resources/index.ts";
export type {
  TransformWhatsAppDelivery,
  WhatsAppActionPayload,
  WhatsAppCarouselImageInput,
  WhatsAppCarouselQuickReplyInput,
  WhatsAppChannelOptions,
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
