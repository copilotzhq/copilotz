/**
 * The terminal plugin: a command line's data, built from the same primitives
 * as everything else, which every process has: where each person is
 * (`shell`), what their commands printed (`output`, kept in memory), and the
 * Actions that change them (`shell.set`, `shell.print`). Its front end, for
 * the process that draws, is ./terminal.ts (the `shell` View); the host that
 * draws it with Ink is `hosts/terminal`. Features bring their own terminal
 * front ends the same way (chat's, memory's, usage's `terminal.ts`).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { printAction } from "./actions/print.ts";
import { setAction } from "./actions/set.ts";
import { output } from "./collections/output.ts";
import { shell } from "./collections/shell.ts";

export * from "../../../hosts/terminal/contract.ts";

export const terminalPlugin: Plugin = definePlugin({
  name: "terminal",
  collections: { shell, output },
  actions: { "shell.set": setAction, "shell.print": printAction },
});

export default terminalPlugin;
