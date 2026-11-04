/**
 * A message on the phone, as it's said: Markdown's marks go, links say
 * their words, web addresses their site, emoji go, a line's end is a pause.
 * What's said of words already whole never changes as more is written, so
 * streaming never says a word twice, or two ways.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import { spoken } from "../views/message.ts";

test("Markdown, as it's said aloud", () => {
  assertEquals(spoken("**Olá!** Temos _três_ horários:"), "Olá! Temos três horários:");
  assertEquals(
    spoken("## Horários\n- Às sete horas\n- Às nove horas\n\nQual prefere? 🚌"),
    "Horários. Às sete horas. Às nove horas. Qual prefere?",
  );
  assertEquals(
    spoken(
      "Compre em [nosso site](https://www.mobifacil.com.br/passagens) ou em https://www.mobifacil.com.br.",
    ),
    "Compre em nosso site ou em mobifacil.com.br.",
  );
  assertEquals(spoken("Use `start_booking` > ok"), "Use start_booking > ok");
});

test("what's whole is said the same however much more is written", () => {
  const text =
    "**Encontrei** três viagens:\n- Às [sete](https://x.y/a) horas 🚌\n- Às nove.\n\nQual?";
  const whole = spoken(text);
  for (let n = 1; n <= text.length; n++) {
    const now = spoken(text.slice(0, n));
    // Up to its last space, what's said of a part is how the whole begins.
    const ready = now.slice(0, now.search(/\s\S*$/) + 1 || 0);
    assertEquals(whole.startsWith(ready), true, `after ${n} characters: "${ready}"`);
  }
});
