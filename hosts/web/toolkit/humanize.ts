/**
 * A field's name as a person reads it: its last part, in words, the first
 * capitalised. A time's trailing "at" goes, and short words that are
 * initials are spelled as such.
 *
 * ```ts
 * humanize("createdAt"); // "Created"
 * humanize("tags.thread"); // "Thread"
 * humanize("_id"); // "ID"
 * humanize("max_tokens"); // "Max tokens"
 * ```
 */

/** Words that are initials. */
const INITIALS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  url: "URL",
  urls: "URLs",
  api: "API",
  ip: "IP",
  ui: "UI",
  llm: "LLM",
};

export function humanize(field: string): string {
  const name = field.split(".").filter(Boolean).at(-1) ?? field;
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_:-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  // "createdAt", "expiresOn": the time is what the row says, so the word goes.
  if (words.length > 1 && (words.at(-1) === "at" || words.at(-1) === "on")) words.pop();
  if (!words.length) return field;
  if (words.length === 1 && words[0] === "at") return "When";
  const text = words.map((word) => INITIALS[word] ?? word).join(" ");
  return text[0].toUpperCase() + text.slice(1);
}
