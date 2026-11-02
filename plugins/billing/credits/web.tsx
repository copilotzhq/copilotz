/**
 * Credits' web front end: the org page's Billing section (the web shell's
 * `orgSettings`): what the org has and how it'll be spent, adding credits and
 * redeeming a gift code, its plan, its month's budget and its history; for
 * platform staff, setting all of that by hand. And a short note above where
 * you type (chat's `composerNotes`), so people know before they send that the
 * org is out, or running low. Add it beside the web shell, where the browser
 * draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { composerNoteView } from "./views/web/composer.tsx";
import { orgBillingView } from "./views/web/org.tsx";

export const creditsWeb: Plugin = definePlugin({
  name: "credits-web",
  requires: ["web-shell"],
  views: {
    "billing.org": { web: orgBillingView },
    "billing.composer": { web: composerNoteView },
  },
  resources: {
    orgSettings: {
      billing: {
        title: "Billing",
        view: "billing.org",
        icon: "star",
        order: 25,
        roles: ["owner", "admin"],
      },
    },
    composerNotes: { billing: { view: "billing.composer" } },
  },
});

export default creditsWeb;
