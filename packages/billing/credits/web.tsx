/**
 * Credits' web front end: the org page's Billing section (the web shell's
 * `orgSettings`): what the org has and how it'll be spent, adding credits and
 * redeeming a gift code, its plan, its month's budget and its history; for
 * platform staff, setting all of that by hand. And a short note above where
 * you type (chat's `composerNotes`), so people know before they send that the
 * org is out, or running low. Add it beside the web shell, where the browser
 * draws. As a team org starts (chat's `welcome`), choosing its plan
 * (`billing.setup`).
 */
import { definePlugin, type Plugin } from "copilotz";
import { composerNoteView } from "./views/web/composer.tsx";
import { orgBillingView } from "./views/web/org.tsx";
import { billingSetupView } from "./views/web/setup.tsx";

export const creditsWeb: Plugin = definePlugin({
  name: "credits-web",
  requires: ["web-shell"],
  views: {
    "billing.org": orgBillingView,
    "billing.composer": composerNoteView,
    "billing.setup": billingSetupView,
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
    // Chat's welcome, for who runs a team org: it comes with no credits, so a plan first.
    welcome: {
      plan: {
        title: "Choose a plan",
        description: "Your agents start working once the org has credits.",
        view: "billing.setup",
        order: 5,
        roles: ["owner", "admin"],
        orgs: ["team"],
      },
    },
  },
});

export default creditsWeb;
