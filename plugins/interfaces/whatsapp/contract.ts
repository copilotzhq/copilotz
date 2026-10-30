/**
 * The WhatsApp plugin's contract: what other plugins and apps may import:
 * the shapes of a connected number, a linked phone and a WhatsApp
 * conversation, and of the plugin's settings (the `whatsapp` resource).
 * They reach the rest by name: its collections (`whatsapp_number`,
 * `whatsapp_phone`, `whatsapp_thread`), its event (`whatsapp.received`) and
 * its Actions (`whatsapp.connect`, `whatsapp.credentials`,
 * `whatsapp.disconnect`, `whatsapp.webhook`, `whatsapp.link`,
 * `whatsapp.unlink`, `whatsapp.move`).
 */
export type { WhatsAppNumber } from "./collections/number.ts";
export type { WhatsAppPhone } from "./collections/phone.ts";
export type { WhatsAppCode } from "./collections/code.ts";
export type { WhatsAppThread } from "./collections/thread.ts";
export type { WhatsAppSettings } from "./shared/settings.ts";
