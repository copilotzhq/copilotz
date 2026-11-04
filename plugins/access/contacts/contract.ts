/**
 * The contacts plugin's contract: what other plugins and apps may import:
 * the shape of a contact, and how one shows as an actor (`contact:<id>`, a
 * message's `from`). They reach the rest by name: its collection
 * (`contact`, and its `names` query), its Actions (`contact.start`,
 * `contact.chat`).
 */
export { CONTACT, type Contact } from "./collections/contact.ts";
