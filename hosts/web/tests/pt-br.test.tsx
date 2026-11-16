/**
 * Brazilian Portuguese out of the box (`ptBR`, `copilotz/web/pt-br`): a phrase for every key the
 * web front ends show (hosts/web/WORDS.md) and none they don't, each with the blanks its English
 * has and plural forms where it has them; every phrase of the sign-in page, the same way; and
 * Copilotz's pitch beside the form, point for point. As a plugin of the page's, it's what the
 * page says, and an app's own plugin after it still has the last word.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import "../../../plugins/agents/web.tsx";
import "../../../plugins/access/web.tsx";
import "../../../plugins/billing/web.tsx";
import "../../../plugins/interfaces/web.tsx";
import "../mod.ts";
import { definePlugin } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { COPILOTZ_ABOUT, SIGN_IN_WORDS, signInPageOf } from "../signin-words.ts";
import { type Phrase, wordsOf } from "../words.ts";
import { ptBR } from "../pt-br/mod.ts";
import { frontEndWords } from "./keys.ts";

/** The blanks a text has (`{name}`), sorted. */
const blanksOf = (text = "") => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

/**
 * What's wrong with a translation of `english`: its shape, or its blanks, form by form (a plural
 * form against the English's of the same category, else its `other`). A plural's form may say
 * its count in words ("uma conversa"), so `{count}` may go.
 */
function wrong(key: string, english: Phrase, said: Phrase | undefined): string[] {
  if (said === undefined) return [`${key}: missing`];
  if (typeof english !== typeof said) return [`${key}: ${typeof english}, said as ${typeof said}`];
  if (typeof english === "string" || typeof said === "string") {
    const [want, got] = [blanksOf(english as string), blanksOf(said as string)];
    return want.join() === got.join() ? [] : [`${key}: blanks ${got}, not ${want}`];
  }
  // Portuguese's plural categories are `one`, `many` and `other`: `other` stands for `many`.
  if (!said.other || (english.one && !said.one)) return [`${key}: plural forms missing`];
  return Object.entries(said).flatMap(([form, text]) => {
    const want = blanksOf(english[form as keyof typeof english] ?? english.other);
    const got = blanksOf(text);
    const fits = want.every((name) => got.includes(name) || name === "count") &&
      got.every((name) => want.includes(name));
    return fits ? [] : [`${key}.${form}: blanks ${got}, not ${want}`];
  });
}

test("a phrase for every key the web front ends show, with the English's blanks and plurals", () => {
  const english = frontEndWords();
  const said = wordsOf([ptBR]);
  const keys = Object.keys(english);
  assert(keys.length > 700, `${keys.length} keys known: the front ends' words weren't loaded`);
  assertEquals(keys.flatMap((key) => wrong(key, english[key], said[key])), []);
  // None for a key no front end shows (one renamed or gone).
  assertEquals(Object.keys(said).filter((key) => !(key in english)), []);
  // Said, not copied: most phrases differ from the English.
  const same = keys.filter((key) => JSON.stringify(english[key]) === JSON.stringify(said[key]));
  assert(same.length < 40, `the same as English: ${same.join(", ")}`);
});

test("every phrase of the sign-in page, and Copilotz's pitch point for point", () => {
  const { words, about } = signInPageOf([ptBR]);
  const keys = Object.keys(SIGN_IN_WORDS) as (keyof typeof SIGN_IN_WORDS)[];
  const given = (ptBR.resources?.signInPage as { words: Record<string, string> }).words;
  assertEquals(Object.keys(given).filter((key) => !(key in SIGN_IN_WORDS)), []);
  assertEquals(keys.flatMap((key) => wrong(key, SIGN_IN_WORDS[key], given[key])), []);
  assertEquals(words.signIn, "Entrar");
  assertEquals(words.password, "Senha");
  assertNotEquals(about?.headline, COPILOTZ_ABOUT.headline);
  assertEquals(
    about?.points?.map((point) => point.icon),
    COPILOTZ_ABOUT.points?.map((point) => point.icon),
  );
});

test("an app's own plugin after it has the last word: its phrases, its pitch", () => {
  const brand = definePlugin({
    name: "brand",
    resources: {
      words: { "chat.send": "Mandar" },
      signInPage: { words: { signIn: "Acessar" }, about: { headline: "Seus projetos," } },
    },
  });
  assertEquals(wordsOf([ptBR, brand])["chat.send"], "Mandar");
  assertEquals(wordsOf([ptBR, brand])["chat.stop"], wordsOf([ptBR])["chat.stop"]);
  const page = signInPageOf([ptBR, brand]);
  assertEquals([page.words.signIn, page.words.password], ["Acessar", "Senha"]);
  assertEquals(page.about, { headline: "Seus projetos," });
  // An app with no pitch of its own after it shows Copilotz's, in Portuguese.
  assertEquals(
    signInPageOf([ptBR, definePlugin({ name: "app" })]).about?.headline,
    "Seus agentes,",
  );
});
