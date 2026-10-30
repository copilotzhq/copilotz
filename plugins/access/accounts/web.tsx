/**
 * Connected accounts' web front end, for the browser: the Connected
 * accounts page (`/accounts`: each provider the app offers, connecting it
 * in a dialog, the person's account there, reconnecting and disconnecting
 * it), its entries in the command palette (going there, connecting,
 * reconnecting or disconnecting each provider), and in a chat, over where
 * you type, a quiet word when its agents run on your plan (chat's
 * `conversation` resource) or would, if you reconnected it.
 *
 * For the shell's account menu, it names its page in `userMenu` (the menu
 * by the person's name, when the shell has one). Add it beside the web shell
 * and chat's front end:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, accountsWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { accountsView } from "./views/web/accounts.tsx";
import { accountsPaletteView } from "./views/web/palette.ts";
import { accountsUsesView } from "./views/web/uses.tsx";

export const accountsWeb: Plugin = definePlugin({
  name: "accounts-web",
  requires: ["accounts", "web-shell"],
  views: {
    accounts: { web: accountsView },
    "accounts.palette": { web: accountsPaletteView },
    "accounts.uses": { web: accountsUsesView },
  },
  resources: {
    palette: { accounts: { view: "accounts.palette", order: 90 } },
    conversation: { accounts: { view: "accounts.uses", order: 90 } },
    userMenu: {
      accounts: { label: "Connected accounts", icon: "lock", href: "/accounts", order: 10 },
    },
  },
});

export default accountsWeb;
