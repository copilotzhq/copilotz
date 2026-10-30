/// <reference lib="dom" />
/**
 * A terminal, for a shell that runs a line at a time (not a PTY): xterm.js
 * in the theme's colours (`terminal-theme.ts`, light and dark), filling its
 * box and fitting it as it changes size.
 *
 * You type at a prompt (where you are, `session.prompt()`, then `$`), with
 * the history ↑ ↓ and a shell's editing keys (`line-editor.ts`). Enter runs
 * the line (`session.run`), and what it prints comes as it comes: plain, as
 * an error, or as a quiet note of the terminal's own. While it runs, a line
 * you type is its input (`session.input`), and Ctrl+C stops it
 * (`session.interrupt`); Ctrl+L clears the screen. `session.start` runs
 * first, as a command would (to pick up one still running). What's entered
 * is kept in the browser under `historyKey`, for next time.
 *
 * xterm.js loads the first time a terminal shows (`xterm.ts`), in files of
 * its own; until then it says it's opening, and if it can't, why.
 *
 * ```tsx
 * <Terminal label="Terminal" historyKey="laptop:personal" session={{
 *   prompt: () => "personal",
 *   run: async (line, out) => out.write(`you said ${line}\n`),
 * }} />
 * ```
 */
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "./button.tsx";
import { cx } from "./cx.ts";
import { cells, edit, emptyLine, HISTORY, type Line } from "./line-editor.ts";
import { Notice } from "./notice.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";
import { terminalTheme } from "./terminal-theme.ts";
import { loadXterm, useXterm, type Xterm } from "./xterm.ts";

/** Where a running line's output goes. */
export type TerminalOutput = {
  /** What it printed. */
  write(text: string): void;
  /** What went wrong (its stderr), in the error tone. */
  error(text: string): void;
  /** A quiet line of the terminal's own, on a line of its own: how it ended, why it can't. */
  note(text: string): void;
  /** Aborted when the terminal goes (what runs may go on; the terminal stops listening). */
  signal: AbortSignal;
};

/** What a terminal runs lines with. */
export type TerminalSession = {
  /** Where you are, shown before what you type; asked each time the prompt shows. */
  prompt(): string;
  /** Runs a line entered at the prompt; it resolves when it's done. */
  run(line: string, out: TerminalOutput): Promise<void>;
  /** A line typed while one runs: its input. */
  input?(line: string, out: TerminalOutput): void | Promise<void>;
  /** Ctrl+C while one runs. */
  interrupt?(out: TerminalOutput): void | Promise<void>;
  /** What it does first, as a line run would; it resolves when that's done. */
  start?(out: TerminalOutput): Promise<void>;
};

const SHEET = sheet(
  "terminal",
  `
.copilotz-terminal { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  padding: 10px 4px 4px 14px; border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); overflow: hidden; transition: border-color .15s, outline-color .15s;
  outline: 3px solid transparent; }
.copilotz-terminal:focus-within { border-color: color-mix(in oklab, var(--ring) 45%, var(--border));
  outline-color: color-mix(in oklab, var(--ring) 10%, transparent); }
.copilotz-terminal-screen { flex: 1; min-height: 0; }
.copilotz-terminal-screen .xterm { height: 100%; }
.copilotz-terminal-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  gap: 10px; color: var(--muted-foreground); font-size: 13.5px; }
.copilotz-terminal-failed { position: absolute; inset: 14px; align-self: center; height: fit-content; }
`,
);

/** Each line of `text` in an SGR colour (`31`: red), so any part redrawn keeps it. */
const toned = (text: string, code: string) =>
  text.split("\n").map((line) => line ? `\x1b[${code}m${line}\x1b[39m` : line).join("\n");

/** A line of output longer than this is left as it is, not redrawn with what's typed after it. */
const LONGEST = 2000;

const stored = (key?: string): string[] => {
  if (!key) return [];
  try {
    const kept = JSON.parse(localStorage.getItem(`copilotz-terminal:${key}`) ?? "[]");
    return Array.isArray(kept) ? kept.filter((s) => typeof s === "string").slice(-HISTORY) : [];
  } catch {
    return [];
  }
};

const store = (key: string | undefined, history: string[]) => {
  if (!key) return;
  try {
    localStorage.setItem(`copilotz-terminal:${key}`, JSON.stringify(history));
  } catch { /* Private, or full: it's kept for this page only. */ }
};

/** Opens xterm.js in `screen`, over the session `latest` gives; what to call when it goes. */
function open(
  xterm: Xterm,
  screen: HTMLElement,
  options: { session: () => TerminalSession; historyKey?: string; focus: boolean },
): () => void {
  const style = getComputedStyle(screen);
  const term = new xterm.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: 13,
    lineHeight: 1.3,
    scrollback: 5000,
    theme: terminalTheme(screen),
  });
  const fit = new xterm.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  fit.fit();
  const gone = new AbortController();

  let line: Line = emptyLine(stored(options.historyKey));
  /** A line running: what's typed goes to it. */
  let busy = false;
  /** What comes before what's typed on its row: the prompt, or what's running wrote last. */
  let lead = "";
  /** The cursor's row, counting from the row the lead starts on. */
  let row = 0;

  const prompt = () => `\x1b[1;34m${options.session().prompt()}\x1b[0m \x1b[90m$\x1b[39m `;

  /** The lead and the line, the cursor where it is in it, over what was there. */
  const draw = () => {
    const cols = Math.max(1, term.cols);
    const before = cells(lead);
    const total = before + [...line.text].length;
    const target = before + line.at;
    let out = (row > 0 ? `\x1b[${row}A` : "") + "\r\x1b[J" + lead + line.text;
    // Ending in the last column, the cursor waits there: a space takes it on to the next row.
    if (total > 0 && total % cols === 0) out += " \r";
    const end = Math.floor(total / cols);
    row = Math.floor(target / cols);
    if (end > row) out += `\x1b[${end - row}A`;
    out += "\r" + (target % cols ? `\x1b[${target % cols}C` : "");
    term.write(out);
  };

  /** Takes the lead and the line off the screen; the cursor where they started. */
  const erase = () => {
    term.write((row > 0 ? `\x1b[${row}A` : "") + "\r\x1b[J");
    row = 0;
  };

  /** Output, above what's being typed. */
  const print = (text: string) => {
    if (gone.signal.aborted || !text) return;
    if (!busy) {
      erase();
      term.write(text.endsWith("\n") ? text : `${text}\n`);
      return draw();
    }
    const all = lead + text;
    const cut = all.lastIndexOf("\n") + 1;
    erase();
    term.write(all.slice(0, cut));
    lead = all.slice(cut);
    if (cells(lead) > LONGEST) {
      term.write(`${lead}\n`);
      lead = "";
    }
    draw();
  };

  const out: TerminalOutput = {
    write: print,
    error: (text) => print(toned(text, "31")),
    note: (text) => print(`${cells(lead) ? "\n" : ""}${toned(text.replace(/\n$/, ""), "90")}\n`),
    signal: gone.signal,
  };

  /** Runs what `work` does (a line, or the start) while the terminal waits, then prompts again. */
  const running = async (work: () => Promise<void> | undefined) => {
    busy = true;
    lead = "";
    row = 0;
    try {
      await work();
    } catch (error) {
      out.error(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (gone.signal.aborted) return;
    busy = false;
    erase();
    // What it wrote last, unfinished, keeps a line of its own.
    if (cells(lead)) term.write(`${lead}\n`);
    lead = prompt();
    draw();
  };

  /** The line, as entered, keeps its place on the screen; the cursor goes under it. */
  const commit = (text: string, after = "") => {
    erase();
    term.write(`${lead}${text}${after}\n`);
    lead = busy ? "" : lead;
  };

  term.onData((data) => {
    const was = line;
    const edited = edit(line, data);
    line = edited.line;
    switch (edited.happened) {
      case "enter": {
        const text = edited.entered!;
        const session = options.session();
        // What's typed into a running command is its input, not a command to remember.
        if (busy) line = { ...line, history: was.history };
        else store(options.historyKey, line.history);
        if (busy) {
          commit(text);
          draw();
          void Promise.resolve(session.input?.(text, out)).catch((error) =>
            out.error(`${error instanceof Error ? error.message : String(error)}\n`)
          );
          return;
        }
        commit(text);
        if (!text.trim()) {
          lead = prompt();
          return draw();
        }
        return void running(() => session.run(text, out));
      }
      case "interrupt":
        commit(was.text, "\x1b[90m^C\x1b[39m");
        if (busy) void options.session().interrupt?.(out);
        else lead = prompt();
        return draw();
      case "clear":
        term.write("\x1b[2J\x1b[3J\x1b[H");
        row = 0;
        return draw();
      case "beep":
        return;
      default:
        return draw();
    }
  });

  // It fits its box, and keeps the theme's colours when the screen's scheme changes.
  const fitted = () => {
    if (!screen.isConnected || !screen.clientWidth) return;
    fit.fit();
    row = Math.floor((cells(lead) + line.at) / Math.max(1, term.cols));
  };
  const watch = new ResizeObserver(() => requestAnimationFrame(fitted));
  watch.observe(screen);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const recolor = () => term.options.theme = terminalTheme(screen);
  scheme.addEventListener("change", recolor);
  void document.fonts?.ready.then(fitted);

  const session = options.session();
  if (session.start) void running(() => session.start!(out));
  else {
    lead = prompt();
    draw();
  }
  if (options.focus) term.focus();

  return () => {
    gone.abort();
    watch.disconnect();
    scheme.removeEventListener("change", recolor);
    term.dispose();
  };
}

export function Terminal(
  { session, label = "Terminal", historyKey, autoFocus = true, className }: {
    session: TerminalSession;
    /** What it is, said to screen readers. */
    label?: string;
    /** Where its history is kept in the browser: one per shell, say. */
    historyKey?: string;
    autoFocus?: boolean;
    className?: string;
  },
): ReactNode {
  const { xterm, error } = useXterm();
  const screen = useRef<HTMLDivElement>(null);
  const latest = useRef(session);
  latest.current = session;
  useEffect(() => {
    if (!xterm || !screen.current) return;
    return open(xterm, screen.current, {
      session: () => latest.current,
      historyKey,
      focus: autoFocus,
    });
  }, [xterm, historyKey]);
  return (
    <div className={cx("copilotz-terminal", className)} role="group" aria-label={label}>
      {SHEET}
      {xterm?.sheet}
      <div ref={screen} className="copilotz-terminal-screen" />
      {xterm ? null : error
        ? (
          <Notice
            tone="destructive"
            className="copilotz-terminal-failed"
            title="The terminal didn't load"
            action={<Button size="sm" onClick={() => void loadXterm()}>Try again</Button>}
          >
            Check your connection, then try again.
          </Notice>
        )
        : (
          <div className="copilotz-terminal-wait" role="status">
            <Spinner size={15} />
            Opening the terminal…
          </div>
        )}
    </div>
  );
}
