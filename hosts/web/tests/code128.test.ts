/**
 * Code 128 (toolkit/code128.ts): every pattern is a symbol's eleven modules
 * (the stop's thirteen), set B says text as it is, `auto` packs digits two
 * to a symbol in set C, and the check symbol is the weighted sum's.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { bars, code128, symbols } from "../toolkit/code128.ts";

/** The check symbol, as the standard computes it: the start, then each value times its place. */
const check = (start: number, values: number[]) =>
  values.reduce((sum, value, i) => sum + value * (i + 1), start) % 103;

test("each symbol is eleven modules (the stop thirteen), and each its own pattern", () => {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
  const patterns = new Map<number, string>();
  for (const value of [printable, "A123456B", "1234", ""]) {
    const widths = code128(value);
    const said = symbols(value);
    assertEquals(widths.length, said.length * 6 + 1);
    said.forEach((symbol, i) => {
      const stop = i === said.length - 1;
      const pattern = widths.slice(i * 6, i * 6 + (stop ? 7 : 6));
      assertEquals(pattern.reduce((a, b) => a + b, 0), stop ? 13 : 11);
      const known = patterns.get(symbol);
      if (known !== undefined) assertEquals(pattern.join(""), known);
      patterns.set(symbol, pattern.join(""));
    });
  }
  // Every symbol seen drew a pattern no other did.
  assertEquals(new Set(patterns.values()).size, patterns.size);
  // The empty value: start B, its check (104 % 103 = 1), the stop.
  assertEquals(symbols("", { set: "B" }), [104, 1, 106]);
});

test("set B says text as it is, with its check symbol", () => {
  const values = [..."PJJ123C"].map((c) => c.charCodeAt(0) - 32);
  assertEquals(symbols("PJJ123C"), [104, ...values, check(104, values), 106]);
  assertEquals(symbols("POS 12", { set: "B" }), [
    104,
    48,
    47,
    51,
    0,
    17,
    18,
    check(104, [48, 47, 51, 0, 17, 18]),
    106,
  ]);
  // What set B can't say is "?" (31).
  assertEquals(symbols("é", { set: "B" }).slice(1, 2), [31]);
});

test("auto packs digits in set C: all digits, a long run, and back to B", () => {
  assertEquals(symbols("1234"), [105, 12, 34, check(105, [12, 34]), 106]);
  // An odd run at the end: its first digit in B, the rest in C.
  const odd = [33, 34, 17, 99, 23, 45];
  assertEquals(symbols("AB12345"), [104, ...odd, check(104, odd), 106]);
  // A run of six inside: C, then back to B (100) for the text after it.
  const inside = [33, 99, 12, 34, 56, 100, 34];
  assertEquals(symbols("A123456B"), [104, ...inside, check(104, inside), 106]);
  // Short runs stay in B; so does everything when told.
  assertEquals(symbols("A12B")[0], 104);
  assertEquals(symbols("1234", { set: "B" })[1], 17);
  // Thirteen digits (an EAN's): C from the start, the last one in B.
  const ean = [40, 6, 38, 13, 33, 93, 100, 17];
  assertEquals(symbols("4006381333931"), [105, ...ean, check(105, ean), 106]);
});

test("bars: whole-pixel modules as wide as fit, with the scanners' margin when asked", () => {
  const modules = code128("POS 12", { set: "B" }).reduce((a, b) => a + b, 0);
  const tight = bars("POS 12", 300, { set: "B" });
  assertEquals(tight.module, Math.floor(300 / modules));
  assertEquals(tight.width, modules * tight.module);
  assertEquals(tight.bars[0].x, 0);
  const quiet = bars("POS 12", 300, { set: "B", quiet: true });
  assertEquals(quiet.module, Math.floor(300 / (modules + 20)));
  assertEquals(quiet.bars[0].x, 10 * quiet.module);
  // Never under a pixel, however narrow.
  assertEquals(bars("POS 12", 10).module, 1);
});
