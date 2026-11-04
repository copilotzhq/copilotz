/**
 * The contacts plugin's contract: what other plugins and apps may import:
 * the shape of a contact, how one shows as an actor (`contact:<id>`, a
 * message's `from`), whose work an actor's is (`contactOf(event.actor)`:
 * the contact's id, also for the agent working for them), and the shape of
 * its settings (the `web` resource: the web lines the app declares, and
 * their limits by default). They reach the rest by name: its collection
 * (`contact`, and its `names` query), its Actions (`contact.start`,
 * `contact.chat`, `contact.forget`, `contact.arrive`), the web host's
 * entrance it declares (`visitor`) and the event its record's erasure is
 * (`contact.deleted`).
 */
export { CONTACT, type Contact, contactOf } from "./collections/contact.ts";
export {
  LIMITS as WEB_LIMITS,
  type WebLimits,
  type WebLine,
  type WebSettings,
} from "./shared/web.ts";
