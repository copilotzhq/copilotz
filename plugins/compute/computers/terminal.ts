/**
 * Computers' terminal front end: `/computers` and `/computer`. What agents
 * wait on you for at a computer is asked as chat asks everything: chat's
 * terminal shows it above where you type, and `/approve` answers it. Add it
 * beside `computers` where the terminal draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";

export const computersTerminal: Plugin = definePlugin({
  name: "computers-terminal",
  requires: ["computers", "terminal-shell"],
  resources: { commands },
});
