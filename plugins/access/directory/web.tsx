/**
 * The directory's web front end, for apps that serve many orgs behind one
 * address: it fills the web shell's `orgs` slot, and draws the org's pages.
 * Add it beside the web shell's, in the browser; without it, the shell has no
 * org switcher.
 *
 * - **The switcher** (`orgs.switcher`), at the top of the sidebar beside the
 *   app's mark: the org you're in and your standing there; opened, your orgs
 *   (Personal first), invitations to join or decline in place, a new org, the
 *   org's settings, and for staff, every org.
 * - **Beside every page** (`orgs.overlay`): the dialog that makes an org, the
 *   short transition while the page goes into another and the word once it's
 *   there, and, while in an org as platform staff, a line along the top.
 * - **The shell's menu and palette** (`useShellOrgs`, the slot's hook): the
 *   person's email, the org's page and (for staff) every org, and orgs to
 *   switch to, invitations and a new org in the palette.
 * - **The org's page** (`org`, at `/org`): its name, your standing, and the
 *   sections front ends add (the shell's `orgSettings` resource: spaces'
 *   About and Members, usage's Usage), each for the roles it names.
 * - **Staff's console** (`console`, at `/console`): every org, to enter,
 *   rename, suspend, move, export or delete, and gift codes of credits.
 *
 * Its browser half (`useOrgs`, `enterOrg`, `refreshOrgs`…) is here too, and in
 * its contract.ts for other plugins' front ends. Its words keep the keys they
 * had in the shell (`shell.<key>`; see views/web/words.ts).
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, directoryWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { consoleView } from "./views/web/console.tsx";
import { orgView } from "./views/web/org.tsx";
import { overlayView, switcherView, useShellOrgs } from "./views/web/switcher.tsx";

export * from "./views/web/orgs.ts";
export { openNewOrg, useShellOrgs } from "./views/web/switcher.tsx";

export const directoryWeb: Plugin = definePlugin({
  name: "directory-web",
  requires: ["web-shell"],
  views: {
    "orgs.switcher": switcherView,
    "orgs.overlay": overlayView,
    org: orgView,
    console: consoleView,
  },
  resources: {
    orgs: { switcher: "orgs.switcher", overlay: "orgs.overlay", use: useShellOrgs },
  },
});

export default directoryWeb;
