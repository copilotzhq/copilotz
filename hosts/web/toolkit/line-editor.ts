/**
 * The line you type in a terminal, edited as a shell's is: what's typed,
 * where the cursor is in it, and the history ↑ and ↓ go through (the draft
 * you were typing kept while you look). `edit(line, data)` takes what the
 * terminal sends for a key or a paste, and says what it comes to: the line
 * now, and what happened, if anything happened but typing:
 *
 * - `enter`: Enter (or a paste with line breaks, entered whole), with the text;
 * - `interrupt`: Ctrl+C; the line is dropped;
 * - `clear`: Ctrl+L, to clear the screen;
 * - `beep`: nothing to do (Backspace at the start, ↑ past the oldest).
 *
 * It knows Backspace, Delete, ← → (Alt or Ctrl with them: by word), Home and
 * End (and Ctrl+A, Ctrl+E), ↑ ↓, Ctrl+U and Ctrl+K (to the start, to the
 * end), Ctrl+W (the word before) and Ctrl+D (the character under the
 * cursor). Tab has nothing to complete; other control keys are ignored.
 * And how much room output takes on a terminal's line (`cells`).
 */

export type Line = {
  text: string;
  /** Where the cursor is, in characters. */
  at: number;
  /** What was entered before, oldest first. */
  history: string[];
  /** How far back in the history the line is: 0 is the draft. */
  back: number;
  /** What was being typed before going back. */
  draft: string;
};

export type Edited = {
  line: Line;
  happened?: "enter" | "interrupt" | "clear" | "beep";
  /** What was entered. */
  entered?: string;
};

/** As many lines as history keeps. */
export const HISTORY = 200;

export const emptyLine = (history: string[] = []): Line => ({
  text: "",
  at: 0,
  history,
  back: 0,
  draft: "",
});

const chars = (text: string) => [...text];

/** The line with `text`, the cursor at `at`. */
const put = (line: Line, text: string, at: number): Line => ({
  ...line,
  text,
  at: Math.max(0, Math.min(at, chars(text).length)),
});

/** Where the word before the cursor starts. */
const wordStart = (cs: string[], at: number) => {
  let i = at;
  while (i > 0 && /\s/.test(cs[i - 1])) i--;
  while (i > 0 && !/\s/.test(cs[i - 1])) i--;
  return i;
};

/** Where the word after the cursor ends. */
const wordEnd = (cs: string[], at: number) => {
  let i = at;
  while (i < cs.length && /\s/.test(cs[i])) i++;
  while (i < cs.length && !/\s/.test(cs[i])) i++;
  return i;
};

/** The history with `text` entered last (not twice in a row, nor blank). */
export function remember(history: string[], text: string): string[] {
  if (!text.trim() || history[history.length - 1] === text) return history;
  return [...history, text].slice(-HISTORY);
}

/** The line after one key, or a paste. */
export function edit(line: Line, data: string): Edited {
  const cs = chars(line.text);
  const at = line.at;
  const enter = (text: string): Edited => ({
    line: { ...emptyLine(remember(line.history, text)) },
    happened: "enter",
    entered: text,
  });
  switch (data) {
    case "\r":
    case "\n":
      return enter(line.text);
    case "\x03":
      return { line: { ...emptyLine(line.history) }, happened: "interrupt" };
    case "\x0c":
      return { line, happened: "clear" };
    case "\t":
      // Nothing to complete with.
      return { line, happened: "beep" };
    case "\x7f":
    case "\b":
      if (at === 0) return { line, happened: "beep" };
      return { line: put(line, [...cs.slice(0, at - 1), ...cs.slice(at)].join(""), at - 1) };
    case "\x1b[3~":
    case "\x04":
      if (at >= cs.length) return { line, happened: "beep" };
      return { line: put(line, [...cs.slice(0, at), ...cs.slice(at + 1)].join(""), at) };
    case "\x1b[D":
    case "\x1bOD":
    case "\x02":
      return at === 0 ? { line, happened: "beep" } : { line: put(line, line.text, at - 1) };
    case "\x1b[C":
    case "\x1bOC":
    case "\x06":
      return at >= cs.length ? { line, happened: "beep" } : { line: put(line, line.text, at + 1) };
    case "\x1bb":
    case "\x1b[1;3D":
    case "\x1b[1;5D":
      return { line: put(line, line.text, wordStart(cs, at)) };
    case "\x1bf":
    case "\x1b[1;3C":
    case "\x1b[1;5C":
      return { line: put(line, line.text, wordEnd(cs, at)) };
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x01":
      return { line: put(line, line.text, 0) };
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x05":
      return { line: put(line, line.text, cs.length) };
    case "\x15":
      return { line: put(line, cs.slice(at).join(""), 0) };
    case "\x0b":
      return { line: put(line, cs.slice(0, at).join(""), at) };
    case "\x17": {
      const from = wordStart(cs, at);
      return { line: put(line, [...cs.slice(0, from), ...cs.slice(at)].join(""), from) };
    }
    case "\x1b[A":
    case "\x1bOA": {
      if (line.back >= line.history.length) return { line, happened: "beep" };
      const back = line.back + 1;
      const text = line.history[line.history.length - back];
      return {
        line: {
          ...put(line, text, chars(text).length),
          back,
          draft: line.back === 0 ? line.text : line.draft,
        },
      };
    }
    case "\x1b[B":
    case "\x1bOB": {
      if (line.back === 0) return { line, happened: "beep" };
      const back = line.back - 1;
      const text = back === 0 ? line.draft : line.history[line.history.length - back];
      return { line: { ...put(line, text, chars(text).length), back } };
    }
  }
  // Any other escape sequence: a key it doesn't know.
  if (data.startsWith("\x1b")) return { line };
  // A paste with line breaks goes in whole, and is entered.
  if (data.length > 1 && /[\r\n]/.test(data)) {
    const pasted = data.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return enter([...cs.slice(0, at), pasted, ...cs.slice(at)].join(""));
  }
  // Typing (or a paste on one line): what can be shown goes in at the cursor, tabs as spaces.
  const typed = chars(data).map((c) => c === "\t" ? " " : c).filter((c) =>
    c >= " " && c !== "\x7f"
  );
  if (!typed.length) return { line };
  return {
    line: put(line, [...cs.slice(0, at), ...typed, ...cs.slice(at)].join(""), at + typed.length),
  };
}

/** ANSI's control sequences, which take no room on the screen. */
const CONTROL =
  // deno-lint-ignore no-control-regex -- control characters are what it finds.
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** How many cells text takes on its line: after its last carriage return, without control codes. */
export const cells = (text: string): number =>
  [...(text.slice(text.lastIndexOf("\r") + 1).replace(CONTROL, ""))].length;
