/**
 * Channel handlers for Copilotz.
 *
 * Each channel is a single function with the signature:
 *
 * ```ts
 * (request: ChannelRequest, copilotz: Copilotz, config?: Config) => Promise<ChannelResponse>
 * ```
 *
 * Channels are framework-independent: they receive plain request data and
 * return plain response data. The caller is responsible for wiring them
 * into whatever web framework they use (Oxian, Hono, Express, etc.).
 *
 * @module
 */

export { webChannel } from "./web.ts";
export { whatsappChannel } from "./whatsapp.ts";
export type { WhatsAppConfig } from "./whatsapp.ts";
export { zendeskChannel } from "./zendesk.ts";
export type { ZendeskConfig } from "./zendesk.ts";

export type {
  ChannelEvent,
  ChannelRequest,
  ChannelResponse,
} from "./types.ts";

export {
  blobToBase64,
  extractText,
  parseDataUrl,
  splitString,
  timingSafeEqual,
  verifyHmacSha256,
} from "./utils.ts";
