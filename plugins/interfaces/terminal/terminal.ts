/**
 * The terminal's front end, for the process that draws: the `shell` View
 * (what's open, the scrollback, where you type), where you type's prompt,
 * and the View any kind without its own falls back to. Add it beside the
 * terminal's data (`terminalPlugin`, in every process) and the features' own
 * terminal front ends; the host (`hosts/terminal`) draws it:
 *
 * ```ts
 * const runtime = await createRuntime({ store, plugins: [...app, terminalShell, chatTerminal] });
 * await terminal({ runtime, me: "ana" });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { defaultView } from "./views/default.ts";
import { promptView } from "./views/prompt.ts";
import { shellView } from "./views/shell.tsx";

export { terminal, type TerminalOptions } from "../../../hosts/terminal/host.tsx";
export { type Entry, Scrollback } from "../../../hosts/terminal/scrollback.tsx";
export { Part } from "../../../hosts/terminal/part.tsx";
export * from "../../../hosts/terminal/contract.ts";

export const terminalShell: Plugin = definePlugin({
  name: "terminal-shell",
  requires: ["terminal"],
  views: {
    shell: { terminal: shellView },
    prompt: { terminal: promptView },
    // Anything else: its fields, one per line.
    "*": { terminal: defaultView },
  },
});
