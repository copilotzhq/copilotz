/**
 * Contacts on the web: their names, wherever a page shows who wrote
 * (spaces' `names` resource, for the browser): "Ana", not "someone".
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { CONTACT } from "./contract.ts";

export const contactsWeb: Plugin = definePlugin({
  name: "contacts-web",
  resources: { names: { contact: { collection: "contact", prefix: CONTACT } } },
});

export default contactsWeb;
