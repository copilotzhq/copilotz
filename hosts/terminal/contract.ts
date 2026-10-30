/**
 * What the terminal's pieces share: where a person is, what commands get,
 * and the styles text prints in.
 *
 * - **The screen** is the `shell` View (medium `terminal`): what's open,
 *   what commands printed, and where you type. Terminal Views return Ink
 *   elements (`<Text>`, `<Box>`), or plain text.
 * - **Scrollback**: what's done (messages, printed output) prints once, in
 *   order, and stays in the terminal's own history; what's live redraws
 *   below it. A View puts things there with `<Scrollback entries={…} />`.
 * - **Commands** (`/threads`, `/open`…; `"*"` for plain text) are a
 *   resource any plugin adds to. They change where you are (`term.set`) and
 *   print (`term.print`, `term.show`).
 */
import type { Owner } from "../../runtime/mod.ts";

/** One document per person: where they are. Commands change it with `term.set`. */
export type ShellState = {
  _id: string;
  /** What the screen shows: a kind, and the item its View shows. */
  open?: { kind: string; item: Record<string, unknown> };
  /** What the last numbered list showed, for picking one by number. */
  listed?: string[];
  /** The space you work in: new conversations go there. */
  space?: string;
};

/** Something a command printed: text, or an item shown through its kind's View. */
export type Printed = {
  _id: string;
  person: string;
  text?: string;
  kind?: string;
  item?: unknown;
  hints?: Record<string, unknown>;
  at: string;
};

/** What commands reach. */
export type Terminal = {
  /** Who is typing. */
  me: string;
  runtime: Pick<
    Owner,
    "call" | "query" | "describe" | "idle" | "stats" | "cancel" | "emit" | "subscribe"
  >;
  /** This person's shell state. */
  state(): Promise<ShellState>;
  /** Changes it (`null` removes a field), through the `shell.set` Action. */
  set(
    fields: { open?: ShellState["open"] | null; listed?: string[] | null; space?: string | null },
  ): Promise<void>;
  /** Prints `item` through its kind's terminal View (each one, for a list). */
  show(kind: string, item: unknown, hints?: Record<string, unknown>): Promise<void>;
  /** Prints a line of text. */
  print(text: string): Promise<void>;
};

export type Command = {
  description: string;
  /** What follows the command: `"<n>"`, `"[agent]"`. */
  usage?: string;
  /** A key that runs it too, even while a line runs: `"escape"`. */
  key?: "escape";
  run(args: string, term: Terminal): unknown;
};

/** The `commands` resource: slash commands by name, and `"*"` for plain text. */
export type Commands = Record<string, Command>;

/**
 * The `notices` resource: Views the shell shows just above where you type,
 * live, for what waits on the person (an agent's request): each is shown
 * with `{ person }`, and says nothing (undefined) when nothing waits.
 */
export type Notices = Record<string, { view: string; order?: number }>;

export const command = (def: Command): Command => def;

// Styles, as every terminal has them, for text that prints as it is.
export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const accent = (s: string): string => `\x1b[36m${s}\x1b[0m`;
export const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
export const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

/** Cut to `n` characters, marking the cut. */
export const short = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Text without its styles: how wide it shows. */
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
