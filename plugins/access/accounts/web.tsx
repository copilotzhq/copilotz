/**
 * Connected accounts' web front end, for the browser: the Connected
 * accounts page (`/accounts`: each provider the app offers, connecting it
 * in a dialog, the person's account there, reconnecting and disconnecting
 * it, and the person's own API keys for model providers: `accounts.keys`),
 * and its entries in the command palette (going there, connecting,
 * reconnecting or disconnecting each provider). What a chat's agents run on
 * is said over where you type by the tiers' line (its price, on whose plan).
 *
 * Other front ends add a section to the page, below the providers, with an
 * `accountSections` resource: `{ <key>: { view, order } }`, its View given
 * item `{}` and hints `{ query, mode }` (contract.ts's `AccountSection`).
 * Computers' front end adds a person's plans, signed in on their own
 * computers (`plans: { view: "computer.plans" }`).
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
import { ownKeysView } from "./views/web/own-keys.tsx";
import { accountsPaletteView } from "./views/web/palette.ts";

export const accountsWeb: Plugin = definePlugin({
  name: "accounts-web",
  requires: ["accounts", "web-shell"],
  views: {
    accounts: accountsView,
    "accounts.keys": ownKeysView,
    "accounts.palette": accountsPaletteView,
  },
  resources: {
    palette: { accounts: { view: "accounts.palette", order: 90 } },
    userMenu: {
      accounts: { label: "Connected accounts", icon: "lock", href: "/accounts", order: 10 },
    },
  },
});

export default accountsWeb;
