/**
 * Access's terminal front end: how spaces look there, and `/spaces`,
 * `/space`, `/work`, `/invite`, `/invitations`, `/accept`, `/decline`, and
 * requests to join. Add it beside `spaces` where the terminal draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { spacesView } from "./views/terminal/spaces.ts";

export const accessTerminal: Plugin = definePlugin({
  name: "spaces-terminal",
  requires: ["spaces", "terminal-shell"],
  views: { spaces: { terminal: spacesView } },
  resources: { commands },
});
