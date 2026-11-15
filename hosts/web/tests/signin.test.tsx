/**
 * The sign-in page in an app's own words and pitch (React, as the page draws
 * it): with every word given, none of Copilotz's English shows, nor its
 * pitch; the app's headline and points do, its name from the page's title.
 * With no panel, the form stands alone. An app that says nothing shows
 * Copilotz's, as before.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { definePlugin } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { SignIn, type Ways } from "../signin.tsx";
import { COPILOTZ_ABOUT, SIGN_IN_WORDS, signInPageOf } from "../signin-words.ts";

/** What a page shows, as text. */
const text = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ")
    .trim();

/** What it says in attributes people read: placeholders and labels. */
const attributes = (node: React.ReactNode) =>
  [...renderToStaticMarkup(<>{node}</>).matchAll(/(?:placeholder|aria-label)="([^"]*)"/g)].map(
    ([, said]) => said,
  );

const ALL: Ways = { email: { signUp: true }, dev: true };

test("an app's own words and pitch: nothing of Copilotz's English or pitch shows", () => {
  // Every word, marked as the app's.
  const words = Object.fromEntries(Object.keys(SIGN_IN_WORDS).map((key) => [key, `«${key}»`]));
  const app = definePlugin({
    name: "example",
    resources: {
      signInPage: {
        words,
        about: {
          headline: "Seus projetos,",
          quiet: "sempre em dia.",
          points: [{
            icon: "sparkles",
            title: "Agentes que ajudam",
            text: "Respostas em segundos.",
          }],
        },
      },
    },
  });
  const more: Ways[] = [
    { password: true },
    { password: true, dev: true },
    { email: { signUp: true, code: true }, password: true },
  ];
  for (const ways of [ALL, { dev: true as const }, {}, ...more]) {
    const page = <SignIn signIn={ways} page={signInPageOf([app])} />;
    const shown = `${text(page)} ${attributes(page).join(" ")}`;
    assertStringIncludes(shown, "Seus projetos, sempre em dia.");
    assertStringIncludes(shown, "Agentes que ajudam Respostas em segundos.");
    // What's left once the app's own is taken out: only its name (the page's title).
    const left = shown.replace(/«\w+»/g, "").replace(
      /Seus projetos,|sempre em dia\.|Agentes que ajudam|Respostas em segundos\./g,
      "",
    )
      .replace(/Copilotz|000000/g, "").replace(/[\s.,…]/g, "");
    assertEquals(left, "", `${JSON.stringify(ways)}: ${shown}`);
  }
});

test("an app's words in pt-BR, its pitch gone or its own; one that says nothing, Copilotz's", () => {
  const ptBR = definePlugin({
    name: "example",
    resources: {
      signInPage: {
        about: null,
        words: {
          signIn: "Entrar",
          email: "E-mail",
          password: "Senha",
          forgot: "Esqueceu a senha?",
        },
      },
    },
  });
  const alone = text(<SignIn signIn={{ email: { signUp: true } }} page={signInPageOf([ptBR])} />);
  for (const said of ["Entrar", "E-mail", "Senha", "Esqueceu a senha?"]) {
    assertStringIncludes(alone, said);
  }
  for (const point of COPILOTZ_ABOUT.points!) assertEquals(alone.includes(point.title), false);
  assertEquals(alone.includes(COPILOTZ_ABOUT.headline), false);
  // Words it didn't give stay English.
  assertStringIncludes(alone, SIGN_IN_WORDS.createAccount);

  const copilotz = text(<SignIn signIn={{ email: { signUp: true } }} />);
  assertStringIncludes(copilotz, `${COPILOTZ_ABOUT.headline} ${COPILOTZ_ABOUT.quiet}`);
  for (const point of COPILOTZ_ABOUT.points!) assert(copilotz.includes(point.title));
});

test("a username and a password: the form alone, or a click away under email's; a code by email when offered", () => {
  const alone = text(<SignIn signIn={{ password: true }} />);
  for (
    const said of [SIGN_IN_WORDS.ledePassword, SIGN_IN_WORDS.identifier, SIGN_IN_WORDS.password]
  ) {
    assertStringIncludes(alone, said);
  }
  assertEquals(alone.includes(SIGN_IN_WORDS.noWay), false);
  const beside = text(<SignIn signIn={{ email: { signUp: false, code: true }, password: true }} />);
  assertStringIncludes(beside, SIGN_IN_WORDS.identifierInstead);
  assertStringIncludes(beside, SIGN_IN_WORDS.codeInstead);
  assertEquals(beside.includes(SIGN_IN_WORDS.identifier), false);
  // No code offered: no such link.
  const plain = text(<SignIn signIn={{ email: { signUp: true } }} />);
  assertEquals(plain.includes(SIGN_IN_WORDS.codeInstead), false);
  assertEquals(plain.includes(SIGN_IN_WORDS.identifierInstead), false);
});
