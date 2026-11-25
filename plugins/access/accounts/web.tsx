/**
 * Connected accounts' web front end, for the browser: Your AI (`/accounts`:
 * the sections other front ends add, such as the person's plans; each
 * provider the app offers, connecting it in a dialog, or in place with the
 * `accounts.connect` View, the person's account there, reconnecting and
 * disconnecting it; and the person's own API keys for model providers:
 * `accounts.keys`),
 * its entries in the command palette (going there, connecting,
 * reconnecting or disconnecting each provider), and in a chat, over where
 * you type, a quiet word when its agents run on your plan (chat's
 * `conversation` resource) or would, if you reconnected it.
 *
 * Other front ends add a section to the page, over the providers, with an
 * `accountSections` resource: `{ <key>: { view, order, plans? } }`, its View
 * given item `{}` and hints `{ query, mode }` (contract.ts's
 * `AccountSection`). Computers' front end adds the person's plans (`plans:
 * true`: ChatGPT is one of them, not a card of its own) and computers.
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
import { accountsConnectView } from "./views/web/connect.tsx";
import { ownKeysView } from "./views/web/own-keys.tsx";
import { accountsPaletteView } from "./views/web/palette.ts";
import { accountsUsesView } from "./views/web/uses.tsx";

export const accountsWeb: Plugin = definePlugin({
  name: "accounts-web",
  requires: ["accounts", "web-shell"],
  views: {
    accounts: accountsView,
    "accounts.connect": accountsConnectView,
    "accounts.keys": ownKeysView,
    "accounts.palette": accountsPaletteView,
    "accounts.uses": accountsUsesView,
  },
  resources: {
    palette: { accounts: { view: "accounts.palette", order: 90 } },
    conversation: { accounts: { view: "accounts.uses", order: 90 } },
    userMenu: {
      accounts: { label: "Your AI", icon: "sparkles", href: "/accounts", order: 10 },
    },
  },
});

export default accountsWeb;
