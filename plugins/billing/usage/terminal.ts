/**
 * Usage's terminal front end: how totals look there, and `/usage`. Add it
 * beside `usage()` where the terminal draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { totalsView } from "./views/terminal/totals.ts";

export const usageTerminal: Plugin = definePlugin({
  name: "usage-terminal",
  requires: ["usage", "terminal-shell"],
  views: { "usage.totals": { terminal: totalsView } },
  resources: { commands },
});
