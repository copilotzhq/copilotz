/**
 * Computers' terminal front end: `/computers`, `/computer`, `/approvals`,
 * `/approve`, and what agents wait on you for, just above where you type.
 * Add it beside `computers` where the terminal draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { approvalsView } from "./views/terminal/approvals.ts";

export const computersTerminal: Plugin = definePlugin({
  name: "computers-terminal",
  requires: ["computers", "terminal-shell"],
  views: { approvals: { terminal: approvalsView } },
  resources: { commands, notices: { approvals: { view: "approvals" } } },
});
