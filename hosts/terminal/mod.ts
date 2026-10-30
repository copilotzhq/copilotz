/**
 * The terminal host: a command line over a runtime, drawn with Ink. It
 * observes the terminal plugin's `shell` View for the person typing, and runs
 * what they type as commands (the `commands` resource every feature adds to).
 *
 * What features' terminal front ends use, like they'd use Ink: the commands
 * contract (`command`, `Commands`, `Terminal`), the text helpers (`dim`,
 * `accent`, `short`…), and the components (`Scrollback`, `Part`).
 *
 * ```ts
 * await terminal({ runtime, me: "ana", banner: "my app" });
 * ```
 */
export * from "./contract.ts";
export { terminal, type TerminalOptions } from "./host.tsx";
export { type Entry, Scrollback } from "./scrollback.tsx";
export { Part } from "./part.tsx";
export { Composer, TypingContext } from "./composer.tsx";
