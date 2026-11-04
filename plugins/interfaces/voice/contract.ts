/**
 * The voice plugin's contract: what other plugins and apps may import: the
 * shape of a line the app declares and of the plugin's settings (the
 * `voice` resource), its defaults (`VOICE_LIMITS`, `VOICE_GAP`,
 * `VOICE_TEXTS`), a call's record, and Twilio's signature
 * (`twilioSignature`, for a test's fake Twilio). They reach the rest by
 * name: its collections (`voice_call`, `voice_phone`), its Views (`message`
 * and `voice_call`, renderer `voice`) and its tool (`end_call`).
 */
export type { VoiceCall } from "./collections/call.ts";
export {
  GAP as VOICE_GAP,
  LIMITS as VOICE_LIMITS,
  type Limits as VoiceLimits,
  TEXTS as VOICE_TEXTS,
  type Texts as VoiceTexts,
  type VoiceLine,
  type VoiceSettings,
} from "./shared/settings.ts";
export { sign as twilioSignature } from "./shared/signature.ts";
