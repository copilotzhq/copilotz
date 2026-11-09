/**
 * For testing that a front end shows no English of its own once the app gives its words
 * (`copilotz/testing/words`): every known key says `«key»`, a front end is drawn with that table,
 * and whatever English it defines that still shows is a word it forgot to take from the table.
 * And a front end's words as a list (`wordsList`), for its WORDS.md.
 */
import { knownWords, type Phrase, type Words } from "../hosts/web/words.ts";

/** Every known key (of `area`, or all), saying `«area.key»` in each plural form. */
export function pseudoWords(area?: string): Words {
  const words: Words = {};
  for (const [key, phrase] of Object.entries(knownWords())) {
    if (area && !key.startsWith(`${area}.`)) continue;
    words[key] = typeof phrase === "string"
      ? `«${key}»`
      : Object.fromEntries(Object.keys(phrase).map((form) => [form, `«${key}»`])) as Phrase;
  }
  return words;
}

/** The English pieces of `area`'s words (between their blanks, long enough to be words) in `markup`. */
export function englishLeft(markup: string, area: string): string[] {
  // Only what a person reads: text and the attributes that are read aloud or shown on hover.
  const shown = markup.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/«[^»]*»/g, "")
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const left = new Set<string>();
  for (const [key, phrase] of Object.entries(knownWords())) {
    if (!key.startsWith(`${area}.`)) continue;
    const forms = typeof phrase === "string" ? [phrase] : Object.values(phrase);
    for (const form of forms) {
      for (const piece of form!.split(/\{\w+\}/).map((p) => p.trim())) {
        if (piece.length >= 4 && /[A-Za-z]{3}/.test(piece) && shown.includes(piece)) {
          left.add(`${key}: ${piece}`);
        }
      }
    }
  }
  return [...left];
}

/**
 * Words by key with their English, as a Markdown list grouped by area (`shell.goHome` under
 * `## shell`), sorted: what `hosts/web/WORDS.md` is made of, and a package's WORDS.md.
 */
export function wordsList(words: Record<string, Phrase>): string[] {
  const lines: string[] = [];
  let area = "";
  for (const [key, phrase] of Object.entries(words).sort(([a], [b]) => a.localeCompare(b))) {
    const [head] = key.split(".");
    if (head !== area) {
      lines.push("", `## ${head}`, "", "| Key | English |", "|---|---|"), area = head;
    }
    const english = typeof phrase === "string"
      ? phrase
      : Object.entries(phrase).map(([form, text]) => `${form}: ${text}`).join(" / ");
    lines.push(`| \`${key}\` | ${english.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  return lines;
}

/** Phrases as an area defines them (`defineWords(area, phrases)`), by their whole keys. */
export const keyed = (area: string, phrases: Record<string, Phrase>): Record<string, Phrase> =>
  Object.fromEntries(Object.entries(phrases).map(([key, phrase]) => [`${area}.${key}`, phrase]));
