/**
 * Memory's terminal front end: how a memory looks there, and `/memories`.
 * Add it beside `memory` where the terminal draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { memoryLine } from "./views/terminal/memory.ts";

export const memoryTerminal: Plugin = definePlugin({
  name: "memory-terminal",
  requires: ["memory", "terminal-shell"],
  views: { memory: { terminal: memoryLine } },
  resources: { commands },
});
