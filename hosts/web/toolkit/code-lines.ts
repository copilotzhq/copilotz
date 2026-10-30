/** A code block's text as lines (see code-block.tsx): parts in tones, split where lines break. */

/** A tone a part of the text takes. */
export type CodeTone = "error" | "muted" | "accent" | "added" | "removed";

/** A part of the text, in a tone. */
export type CodePart = { text: string; tone?: CodeTone };

/** A line of it: its parts, and the tone the whole line has, if one does. */
export type CodeLine = { parts: CodePart[]; tone?: CodeTone };

/** The text as lines, each its parts, and the tone the whole line has, if one does. */
export function linesOf(code: string | CodePart[]): CodeLine[] {
  const parts = typeof code === "string" ? [{ text: code }] : code;
  const lines: CodeLine[] = [{ parts: [] }];
  for (const part of parts) {
    const pieces = part.text.split("\n");
    pieces.forEach((text, i) => {
      if (i > 0) lines.push({ parts: [] });
      if (text) {
        lines[lines.length - 1].parts.push({ text, ...(part.tone ? { tone: part.tone } : {}) });
      } else if (part.tone && (part.tone === "added" || part.tone === "removed")) {
        // An empty line of a change is still a line of it.
        lines[lines.length - 1].tone = part.tone;
      }
    });
  }
  // A last line break ends the text, whatever its tone; it doesn't start another line.
  const last = lines[lines.length - 1];
  if (lines.length > 1 && !last.parts.length && parts.at(-1)?.text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    const tones = new Set(line.parts.map((p) => p.tone));
    if (line.parts.length && tones.size === 1) {
      const [tone] = tones;
      if (tone) line.tone = tone;
    }
  }
  return lines.length === 1 && !lines[0].parts.length && !lines[0].tone ? [] : lines;
}
