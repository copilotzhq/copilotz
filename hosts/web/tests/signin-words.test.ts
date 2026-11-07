/**
 * What the sign-in page says is the app's: its `signInPage` words patch
 * Copilotz's English one by one, a later plugin's over an earlier one's; its
 * panel (`about`) is given whole, so no Copilotz pitch stays beside an app's
 * own, and `null` leaves the form alone. Blanks are filled where they show.
 */
import { assertEquals } from "@std/assert";
import { definePlugin } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { COPILOTZ_ABOUT, fill, SIGN_IN_WORDS, signInPageOf } from "../signin-words.ts";

test("an app that says nothing signs people in in Copilotz's words, beside its pitch", () => {
  assertEquals(signInPageOf([]), { words: SIGN_IN_WORDS, about: COPILOTZ_ABOUT });
  assertEquals(
    signInPageOf([definePlugin({ name: "other", resources: {} })]).about,
    COPILOTZ_ABOUT,
  );
});

test("an app's words patch the English one by one; a later plugin's win", () => {
  const brand = definePlugin({
    name: "brand",
    resources: {
      signInPage: {
        words: { signIn: "Entrar", email: "E-mail", nonsense: "ignored", password: 3 },
      },
    },
  });
  const later = definePlugin({
    name: "later",
    resources: { signInPage: { words: { email: "Seu e-mail" } } },
  });
  const { words, about } = signInPageOf([[brand], later]);
  assertEquals([words.signIn, words.email, words.password], ["Entrar", "Seu e-mail", "Password"]);
  assertEquals("nonsense" in words, false);
  // Words alone leave the panel as it was.
  assertEquals(about, COPILOTZ_ABOUT);
});

test("an app's panel is its own, whole: nothing of Copilotz's pitch stays; null, none", () => {
  const own = definePlugin({
    name: "brand",
    resources: { signInPage: { about: { headline: "Seu conteúdo, com estratégia." } } },
  });
  assertEquals(signInPageOf([own]).about, { headline: "Seu conteúdo, com estratégia." });
  const none = definePlugin({ name: "plain", resources: { signInPage: { about: null } } });
  assertEquals(signInPageOf([own, none]).about, null);
  assertEquals(signInPageOf([none, own]).about?.headline, "Seu conteúdo, com estratégia.");
});

test("blanks are filled where they show; one nothing fills stays", () => {
  assertEquals(
    fill("Envie um novo código em {seconds}s", { seconds: 12 }),
    "Envie um novo código em 12s",
  );
  assertEquals(fill("Para {email}", {}), "Para {email}");
});
