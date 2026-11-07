/**
 * The words every web front end says: English by default, the app's by key from a `words`
 * resource (a later plugin's over an earlier one's), blanks filled, plurals chosen by the page's
 * language, and the page's `lang` for dates and numbers.
 */
import { assertEquals } from "@std/assert";
import { definePlugin } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import {
  defineWords,
  fill,
  formatDate,
  formatNumber,
  knownWords,
  setWords,
  wordsOf,
} from "../words.ts";

const say = defineWords("demo", {
  send: "Send",
  hello: "Hello, {name}",
  messages: { one: "{count} message", other: "{count} messages" },
});

const plugin = (words: Record<string, unknown>) =>
  definePlugin({ name: `p${Math.random()}`, resources: { words } });

test("without the app's words, a front end says its English", () => {
  assertEquals(say("send"), "Send");
  assertEquals(say("hello", { name: "Ana" }), "Hello, Ana");
  assertEquals(say("messages", { count: 1 }), "1 message");
  assertEquals(say("messages", { count: 3 }), "3 messages");
  assertEquals(knownWords()["demo.send"], "Send");
});

test("the app's words replace the English one by one; the rest stays English", () => {
  const restore = setWords(wordsOf([plugin({ "demo.send": "Enviar", "other.x": "y" })]));
  try {
    assertEquals(say("send"), "Enviar");
    assertEquals(say("hello", { name: "Ana" }), "Hello, Ana");
  } finally {
    restore();
  }
  assertEquals(say("send"), "Send");
});

test("a later plugin's words win; null takes an override back out; non-phrases are ignored", () => {
  const words = wordsOf([
    plugin({ "demo.send": "Enviar", "demo.hello": "Olá, {name}" }),
    [plugin({ "demo.send": "Mandar", "demo.hello": null, "demo.messages": 4 })],
  ]);
  assertEquals(words, { "demo.send": "Mandar" });
});

test("blanks fill where they show; one nothing fills stays; plurals follow the language", () => {
  assertEquals(fill("{a} and {b} and {c}", { a: 1, b: "two" }), "1 and two and {c}");
  const restore = setWords(wordsOf([plugin({
    "demo.messages": { one: "{count} mensagem", other: "{count} mensagens" },
    "demo.hello": "Olá, {name}",
  })]));
  try {
    assertEquals(say("messages", { count: 1 }), "1 mensagem");
    assertEquals(say("messages", { count: 0 }), "0 mensagens");
    assertEquals(say("hello", { name: "Ana" }), "Olá, Ana");
  } finally {
    restore();
  }
});

test("dates and numbers follow the page's lang", () => {
  const document = (globalThis as { document?: unknown }).document;
  try {
    Object.assign(globalThis, { document: { documentElement: { lang: "pt-BR" } } });
    assertEquals(formatNumber(1234.5), "1.234,5");
    assertEquals(
      formatDate(new Date(Date.UTC(2026, 10, 6, 12)), { month: "long", timeZone: "UTC" }),
      "novembro",
    );
    assertEquals(say("messages", { count: 1 }), "1 message");
    Object.assign(globalThis, { document: { documentElement: { lang: "ru" } } });
    const restore = setWords({
      "demo.messages": { one: "{count} a", few: "{count} b", other: "{count} c" },
    });
    assertEquals([1, 2, 5].map((count) => say("messages", { count })), ["1 a", "2 b", "5 c"]);
    restore();
  } finally {
    if (document === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.assign(globalThis, { document });
  }
});
