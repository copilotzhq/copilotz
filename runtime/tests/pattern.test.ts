/**
 * Text patterns (`$regex`): the subset of JavaScript's regular expressions
 * every store reads alike. The matcher answers as JavaScript's own does with
 * the `u` flag (and `i`, `s` for the options), reads a value in time linear
 * in it whatever the pattern, and refuses what's outside the subset as
 * `invalid`, saying why.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { pattern, PATTERN_MOST } from "../pattern.ts";
import { type Actor, createRuntime, defineCollection, definePlugin } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho } from "../../testing/mod.ts";

const PATTERNS = [
  "",
  "ana",
  "^ana",
  "ana$",
  "^ana$",
  "a.a",
  "a.*b",
  "^.$",
  "[a-c]+",
  "[^a-c]",
  "^[^\\n]*$",
  "a|b|",
  "(ab|cd)+e",
  "(?:ab)?c",
  "x{2}",
  "x{2,}",
  "x{1,3}y",
  "x+?y",
  "\\d+",
  "\\D",
  "\\w+$",
  "^\\W*$",
  "\\s",
  "\\S+",
  "[\\d.]+",
  "[\\w-]+@",
  "\\.",
  "\\(\\)\\[\\]\\{\\}\\|\\/\\\\\\^\\$\\*\\+\\?",
  "\\t\\n",
  "\\x41",
  "\\u00e9",
  "\\u{1F600}",
  "😀",
  "jo[ãa]o",
  "ÇÃO",
  "σ",
  "ſ",
  "k",
  "ß",
  "[a-z]",
  "[^a]",
  "[à-ÿ]",
  "(a*)*b",
  "(?:)",
  "^$",
  "[-a]",
  "[a-]",
  "[\\-\\]]",
  "[[]",
];

const TEXTS = [
  "",
  "ana",
  "Ana",
  "ANA",
  "banana",
  "a\na",
  "a\ra",
  "a b",
  "ab",
  "acb",
  "😀",
  "x😀y",
  "abcde",
  "abcdcde",
  "ce",
  "xx",
  "xxxy",
  "xy",
  "123",
  "1.5",
  "word_1",
  "!!",
  " \t",
  " ",
  "a.b",
  "()[]{}|/\\^$*+?",
  "\t\n",
  "A",
  "é",
  "É",
  "João",
  "JOÃO",
  "AÇÃO",
  "ação",
  "Σ",
  "ς",
  "S",
  "s",
  "K",
  "K",
  "ẞ",
  "ss",
  "aab",
  "-",
  "]",
  "[",
  "nome@exemplo.com",
];

test("a pattern matches as JavaScript's own regular expressions do", () => {
  for (const options of ["", "i", "s", "is"]) {
    for (const source of PATTERNS) {
      const own = new RegExp(source, `u${options}`);
      const ours = pattern(source, options);
      for (const text of TEXTS) {
        assertEquals(
          ours.test(text),
          own.test(text),
          `/${source}/${options} on ${JSON.stringify(text)}`,
        );
      }
    }
  }
});

test("ignoring case folds as JavaScript does, accents and all", () => {
  const joao = pattern("joão", "i");
  for (const text of ["JOÃO", "João", "joão"]) assert(joao.test(text), text);
  assert(!joao.test("joao"), "an accent is a letter of its own");
  assert(pattern("[a-z]+", "i").test("K"), "the Kelvin sign folds with k");
  assert(!pattern("[^a]", "i").test("A"), "a class left out folds before it's left out");
  assert(pattern("\\w", "i").test("ſ"));
  assert(!pattern("\\W", "i").test("ſ"));
});

test("a pattern reads each character once, whatever it is", () => {
  // Each of these takes JavaScript's backtracking engine exponential time on such a text.
  const text = "a".repeat(20_000) + "!";
  for (const source of ["(a+)+$", "^(a|a)*$", "(a|aa)*b", "^(\\w+\\s?)*$", "(a*)*b"]) {
    const started = performance.now();
    assertEquals(pattern(source).test(text), false, source);
    assert(performance.now() - started < 2_000, `${source} took ${performance.now() - started}`);
  }
});

test("what isn't in the subset, or doesn't parse, is refused as invalid", () => {
  const refused: [unknown, unknown, string][] = [
    ["(a)\\1", "", "backreference"],
    ["(?=a)", "", "lookarounds"],
    ["(?<!a)b", "", "lookarounds"],
    ["(?<name>a)", "", "lookarounds or named groups"],
    ["\\bword", "", "word boundary"],
    ["\\p{L}", "", "escape"],
    ["\\cA", "", "escape"],
    ["\\0", "", "escape"],
    ["\\-", "", "escape"],
    ["\\uD83D", "", "surrogate"],
    ["(", "", "without its )"],
    ["a)", "", "without its ("],
    ["[a", "", "without its ]"],
    ["[]", "", "empty class"],
    ["[^]", "", "empty class"],
    ["[z-a]", "", "out of order"],
    ["[\\d-z]", "", "class at one end"],
    ["*a", "", "nothing to repeat"],
    ["a**", "", "nothing to repeat"],
    ["a{2}{3}", "", "nothing to repeat"],
    ["^*", "", "repeats ^ or $"],
    ["a{1", "", "isn't a quantifier"],
    ["]", "", "lone ]"],
    ["a{3,2}", "", "out of order"],
    ["a{256}", "", "more than 255"],
    ["(a{255}){255}", "", "states"],
    ["a".repeat(PATTERN_MOST + 1), "", "longer than"],
    ["a\\", "", "lone \\"],
    [/a/, "", "as a string"],
    [1, "", "as a string"],
    ["a", "m", "$options"],
    ["a", "g", "$options"],
    ["a", 1, "$options"],
  ];
  for (const [source, options, why] of refused) {
    const error = assertThrows(() => pattern(source, options), Error, why, String(source));
    assertEquals((error as { code?: string }).code, "invalid", String(source));
  }
});

test("text escaped as JavaScript escapes it is a pattern that matches that text", () => {
  const escape = (RegExp as { escape?: (text: string) => string }).escape ??
    ((text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"));
  for (const text of ["foo-bar", "a,b c", "1+1=2", "(x)", "João Silva", "e@x.com", "😀 50%"]) {
    const found = pattern(escape(text), "i");
    assert(found.test(`>> ${text.toUpperCase()} <<`), text);
    assert(!found.test(text.slice(1)), text);
  }
});

test("an outside caller sends its own pattern over REST, matched within its rule", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      definePlugin({
        name: "names",
        collections: {
          contact: defineCollection({
            schema: {
              type: "object",
              properties: { name: { type: "string" }, owner: { type: "string" } },
              required: ["name", "owner"],
            },
          }),
        },
        guard: (actor, { collection }) =>
          collection === "contact" ? { owner: actor.id } : undefined,
      }),
      testWho,
    ],
  });
  const as = (actor: Actor, path: string, init: RequestInit = {}) =>
    rt.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { [TEST_ACTOR]: JSON.stringify(actor), "content-type": "application/json" },
      }),
    );
  const ana: Actor = { kind: "person", id: "ana" };
  const bob: Actor = { kind: "person", id: "bob" };
  try {
    for (const [who, name] of [[ana, "João"], [ana, "JOANA"], [ana, "Maria"], [bob, "Jonas"]]) {
      const body = JSON.stringify({ name, owner: (who as Actor).id });
      await as(who as Actor, "/api/collections/contact", { method: "POST", body });
    }
    const filter = (value: unknown) => encodeURIComponent(JSON.stringify(value));
    const found = await as(
      ana,
      `/api/collections/contact?filter=${filter({ name: { $regex: "^jo", $options: "i" } })}`,
    );
    assertEquals((await found.json()).map((c: { name: string }) => c.name), ["João", "JOANA"]);
    const refused = await as(
      ana,
      `/api/collections/contact?filter=${filter({ name: { $regex: "(a)\\1" } })}`,
    );
    assertEquals(
      [refused.status, (await refused.json()).error?.code],
      [400, "invalid"],
    );
  } finally {
    await rt.close();
  }
});
