/**
 * Who reads what of WhatsApp's: each person their own linked phones, codes
 * and WhatsApp conversations; nobody else (the plugin's own code acts as
 * the system to find who a phone is). Numbers live in spaces (the spaces
 * plugin's `shared` resource): their members read them, their managers
 * change them; credentials are read by nobody outside. None is written
 * directly from outside: a phone is linked by its code, a number connected
 * by its managers, a template said in a chat, through the plugin's Actions.
 */
import type { Filter, Guard } from "../../../../runtime/mod.ts";
import { failure, personOf } from "../../../../runtime/mod.ts";

const OWN = new Set(["whatsapp_phone", "whatsapp_code", "whatsapp_thread"]);

/** Written only through the plugin's Actions too: numbers, and the templates said in chats. */
const THEIRS = new Set(["whatsapp_number", "whatsapp_template"]);

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

export const rules: Guard = (actor, { collection, access, direct }) => {
  if (direct && access === "write" && (OWN.has(collection) || THEIRS.has(collection))) {
    throw failure("forbidden", "WhatsApp's phones and numbers change through their Actions.", {
      public: true,
    });
  }
  if (!OWN.has(collection)) return undefined;
  const person = personOf(actor);
  return person ? { person } : NOTHING;
};
