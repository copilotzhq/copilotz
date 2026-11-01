/**
 * Who reads what of WhatsApp's: each person their own linked phones, codes
 * and WhatsApp conversations; nobody else (the plugin's own code acts as
 * the system to find who a phone is). Numbers live in spaces (the spaces
 * plugin's `shared` resource): their members read them, their managers
 * change them; credentials are read by nobody outside.
 */
import type { Filter, Guard } from "../../../../runtime/mod.ts";
import { personOf } from "../../../../runtime/mod.ts";

const OWN = new Set(["whatsapp_phone", "whatsapp_code", "whatsapp_thread"]);

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

export const rules: Guard = (actor, { collection }) => {
  if (!OWN.has(collection)) return undefined;
  const person = personOf(actor);
  return person ? { person } : NOTHING;
};
