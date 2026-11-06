/**
 * Every word Copilotz's web front ends show is the app's to change. Each front end
 * keeps its words by key, in English, beside the code that shows them
 * (`defineWords("chat", { send: "Send" })` gives back `say("send")`); an app
 * gives its own in a `words` resource, on any of the plugins the page runs
 * (`web({ plugins })`), under the full key (`chat.send`), merged over the
 * English in order like every resource (a later plugin's win; `null` takes an
 * override back out). An app that gives none looks exactly as before.
 *
 * ```ts
 * definePlugin({
 *   name: "words",
 *   resources: {
 *     words: {
 *       "chat.send": "Enviar",
 *       "chat.greeting": "Boa tarde, {name}",           // blanks, filled where they show
 *       "chat.messages": { one: "{count} mensagem", other: "{count} mensagens" }, // plurals
 *     },
 *   },
 * })
 * ```
 *
 * - **Blanks** are `{name}`s, filled where the phrase shows; one nothing fills stays as written.
 * - **Plurals** are an object by the language's plural categories (`zero`, `one`, `two`, `few`,
 *   `many`, `other`: `Intl.PluralRules`), chosen by the `count` blank; `other` is the fallback.
 * - **Language:** the page's `lang` (`webPage({ lang })`) is what dates, times and numbers are
 *   formatted in (`lang()`, `formatDate`, `formatNumber`…), and picks the plural form.
 *
 * Words are read from one table the page sets at start (`setWords`), so a front end says a word
 * the same in a View, a component or a plain function.
 */
import { createElement, Fragment, type ReactNode } from "react";
import type { Plugins } from "../../runtime/mod.ts";
import { merge } from "../../runtime/registry.ts";

/** A phrase, or its forms by plural category (chosen by the `count` blank). */
export type Phrase = string | Partial<Record<Intl.LDMLPluralRule, string>>;

/** The blanks a phrase may have, by name. */
export type Blanks = Record<string, string | number>;

/** What an app gives: phrases by full key (`area.key`). */
export type Words = Record<string, Phrase>;

/**
 * Says a word of one front end: its phrase, in the app's words or the English, blanks filled.
 * `say.nodes` fills blanks with elements (`<b>`, a link), for a phrase that wraps one: the
 * language decides where it goes in the sentence.
 */
export type Say<K extends string> = {
  (key: K, blanks?: Blanks): string;
  nodes(key: K, blanks: Record<string, ReactNode>): ReactNode;
};

/** Every front end's English, by full key, as they define it. */
const english = new Map<string, Phrase>();
/** The app's words, by full key. */
let given: Words = {};

/**
 * Registers a front end's words (`area` is the key's first part: `chat`) and returns how it says
 * them. Keys are plain English names in camelCase; one added here appears in the keys list.
 */
export function defineWords<const W extends Record<string, Phrase>>(
  area: string,
  phrases: W,
): Say<Extract<keyof W, string>> {
  for (const [key, phrase] of Object.entries(phrases)) english.set(`${area}.${key}`, phrase);
  const phrase = (key: string) => given[`${area}.${key}`] ?? phrases[key];
  const say = (key: string, blanks?: Blanks) => render(phrase(key), blanks);
  say.nodes = (key: string, blanks: Record<string, ReactNode>) => {
    const count = blanks.count;
    const text = render(phrase(key), typeof count === "number" ? { count } : undefined);
    // Split around the blanks: text, element, text…; a blank nothing fills stays as written.
    return createElement(
      Fragment,
      null,
      ...text.split(/(\{\w+\})/).map((part, i) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const node = name !== undefined && name in blanks ? blanks[name] : part;
        return createElement(Fragment, { key: i }, node);
      }),
    );
  };
  return say as Say<Extract<keyof W, string>>;
}

/** A phrase as it shows: its plural form for `count`, its blanks filled. */
function render(phrase: Phrase, blanks?: Blanks): string {
  let text: string;
  if (typeof phrase === "string") text = phrase;
  else {
    const category = typeof blanks?.count === "number"
      ? new Intl.PluralRules(lang()).select(blanks.count)
      : "other";
    text = phrase[category] ?? phrase.other ?? Object.values(phrase)[0] ?? "";
  }
  return blanks ? fill(text, blanks) : text;
}

/** A phrase with its blanks filled (`{name}`); a blank nothing fills stays as it is. */
export const fill = (text: string, blanks: Blanks): string =>
  text.replace(
    /\{(\w+)\}/g,
    (blank, name: string) => name in blanks ? String(blanks[name]) : blank,
  );

/**
 * The app's words: the `words` resources of its plugins merged in order (a later one's win),
 * keeping only phrases (a string, or plural forms of strings). Anything else is ignored.
 */
export function wordsOf(plugins: Plugins): Words {
  const merged = merge(plugins as Parameters<typeof merge>[0], { elsewhere: true }).resources
    .words as Record<string, unknown> | undefined;
  const words: Words = {};
  for (const [key, value] of Object.entries(merged ?? {})) {
    if (typeof value === "string") words[key] = value;
    else if (value && typeof value === "object") {
      const forms = Object.entries(value).filter(([, form]) => typeof form === "string");
      if (forms.length) words[key] = Object.fromEntries(forms) as Phrase;
    }
  }
  return words;
}

/** Sets the words the page says (`web` does, from its plugins); returns how to put back what was. */
export function setWords(words: Words): () => void {
  const before = given;
  given = words;
  return () => {
    given = before;
  };
}

/** Every key Copilotz's front ends define (those loaded), with its English. */
export const knownWords = (): Record<string, Phrase> => Object.fromEntries(english);

/** The page's language (its `<html lang>`), English unless said. */
export const lang = (): string => globalThis.document?.documentElement?.lang || "en";

/** A date as the page's language writes it. */
export const formatDate = (date: Date, options?: Intl.DateTimeFormatOptions): string =>
  date.toLocaleDateString(lang(), options);

/** A time of day as the page's language writes it. */
export const formatTime = (date: Date, options?: Intl.DateTimeFormatOptions): string =>
  date.toLocaleTimeString(lang(), options);

/** A date and time as the page's language writes them. */
export const formatDateTime = (date: Date, options?: Intl.DateTimeFormatOptions): string =>
  date.toLocaleString(lang(), options);

/** A number as the page's language writes it. */
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string =>
  n.toLocaleString(lang(), options);

/** A list as the page's language writes it ("a, b and c"). */
export const formatList = (items: string[], type: "conjunction" | "disjunction" = "conjunction") =>
  new Intl.ListFormat(lang(), { style: "long", type }).format(items);
