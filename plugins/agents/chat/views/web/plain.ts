/**
 * A message's text as one plain line, for a title or a preview (markdown's
 * marks left out), and a title cut short enough to name a step.
 */

/** A message's text as one plain line: markdown's marks left out. */
export const plain = (text = ""): string =>
  text
    .replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, " $1 ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A title short enough to say in a step's name ("Move “Plan the…” to…"). */
export const shortened = (title: string, most = 40): string =>
  title.length > most ? `${title.slice(0, most - 1).trimEnd()}…` : title;
