/**
 * The WhatsApp plugin's contract: what other plugins and apps may import:
 * the shapes of a connected number, a linked phone and a WhatsApp
 * conversation, and of the plugin's settings (the `whatsapp` resource); and
 * the medium's toolkit, for `whatsapp` Views: the parts a View returns,
 * each one WhatsApp message, built and checked against Meta's limits
 * (`text`, `buttons`, `list`, `carousel`, `image`, `document`; `clip` cuts a
 * title on purpose).
 *
 * ```ts
 * views: {
 *   "addition:booking": {
 *     whatsapp: ({ thread }, ctx) => ({
 *       key: `trips:${search}`,
 *       parts: [carousel("Some trips for 12/11", cards)],
 *       fallback: [text(numbered)],
 *       note: "6 trips as a carousel",
 *     }),
 *   },
 * }
 * ```
 *
 * A tap comes back as the message's `tap` (`{ id, title, key }`): what was
 * chosen, never what may be done. Agents read its id as it came, so a tool
 * acting on one (choosing a trip) checks it against what was shown there.
 *
 * They reach the rest by name: its collections (`whatsapp_number`,
 * `whatsapp_phone`, `whatsapp_thread`), its event (`whatsapp.received`) and
 * its Actions (`whatsapp.connect`, `whatsapp.credentials`,
 * `whatsapp.disconnect`, `whatsapp.webhook`, `whatsapp.link`,
 * `whatsapp.unlink`, `whatsapp.move`, `whatsapp.set`, `whatsapp.block`).
 */
export { GAP, type WhatsAppNumber } from "./collections/number.ts";
export type { WhatsAppPhone } from "./collections/phone.ts";
export type { WhatsAppCode } from "./collections/code.ts";
export type { WhatsAppThread } from "./collections/thread.ts";
export type { WhatsAppLine, WhatsAppSettings } from "./shared/settings.ts";
export {
  buttons,
  type Card,
  carousel,
  type Choice,
  clip,
  document,
  image,
  list,
  type Row,
  type Section,
  text,
  type WaMedia,
  type WaPart,
} from "./shared/parts.ts";
