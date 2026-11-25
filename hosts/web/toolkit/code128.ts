/**
 * Code 128, the barcode receipts, labels and shelf tags print: what a value
 * is in its symbols, and those symbols as bars and spaces. Pure, so a
 * server draws the same barcode as the page (a PDF, an e-mail).
 *
 * Text is code set B (printable ASCII, 32–126; anything else becomes "?").
 * `auto` (the default) also packs runs of digits two to a symbol in code
 * set C: from the start when the value opens with four digits or more (or
 * is all digits, an even count), and inside it for a run of six or more
 * (four at its end), which is how long numbers stay short.
 *
 * ```ts
 * code128("POS 12", { set: "B" }); // [2, 1, 1, 2, 1, 4, …]: bar, space, bar… in modules
 * bars("4006381333931", 300);       // { module, width, bars: [{ x, w }, …] }
 * ```
 */

import { code39, ean13, ean8 } from "./retail-barcodes.ts";

/** Selects the barcode drawn on screen, paper, or as a PNG. Code 128 is the default. */
export type BarcodeOptions = {
  format?: "code128" | "code39" | "ean8" | "ean13";
  set?: "auto" | "B";
  check?: boolean;
  quiet?: boolean;
};

/** The 107 patterns (values 0–105, then STOP), as module widths: bar, space, bar, space, bar, space(, bar). */
const PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];

const CODE_C = 99;
const CODE_B = 100;
const START_B = 104;
const START_C = 105;
const STOP = 106;

/** The digits from `at` on, how many. */
const digitsAt = (chars: string[], at: number) => {
  let end = at;
  while (end < chars.length && chars[end] >= "0" && chars[end] <= "9") end++;
  return end - at;
};

/** A character's value in code set B ("?" for what it can't say). */
const valueB = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 32 && code <= 126 ? code - 32 : 31;
};

/**
 * The symbols' values for `text`: the start, the data (with the switches
 * between sets), the check symbol and the stop.
 */
export function symbols(text: string, { set = "auto" }: { set?: "auto" | "B" } = {}): number[] {
  const chars = [...text];
  const values: number[] = [];
  let at = 0;
  let inC = false;
  const run = set === "auto" ? digitsAt(chars, 0) : 0;
  const start = set === "auto" && (run >= 4 || (run === chars.length && run >= 2 && run % 2 === 0))
    ? START_C
    : START_B;
  if (start === START_C) inC = true;
  while (at < chars.length) {
    if (inC) {
      const digits = digitsAt(chars, at);
      if (digits >= 2) {
        values.push(Number(chars[at] + chars[at + 1]));
        at += 2;
        continue;
      }
      values.push(CODE_B);
      inC = false;
      continue;
    }
    const digits = set === "auto" ? digitsAt(chars, at) : 0;
    const atEnd = at + digits === chars.length;
    if (digits >= 6 || (atEnd && digits >= 4)) {
      // An odd run says its first digit in set B, the even rest in C.
      if (digits % 2 === 1) {
        values.push(valueB(chars[at]));
        at++;
      }
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(valueB(chars[at]));
    at++;
  }
  const check = values.reduce((sum, value, i) => sum + value * (i + 1), start) % 103;
  return [start, ...values, check, STOP];
}

/** The module widths of `text`'s barcode, starting with a bar: bar, space, bar… */
export function code128(text: string, options?: { set?: "auto" | "B" }): number[] {
  return symbols(text, options).flatMap((symbol) => [...PATTERNS[symbol]].map(Number));
}

/**
 * The bars of `text`, drawn `width` pixels wide at most with whole pixels per
 * module (so they stay sharp; at least one): each bar's `x` and `w`, the
 * module's size and the barcode's whole width, in pixels. `quiet` adds the
 * blank margin scanners need at each end (ten modules).
 */
export function bars(
  text: string,
  width = 300,
  options: BarcodeOptions = {},
): { module: number; width: number; bars: { x: number; w: number }[] } {
  const widths = options.format === "code39"
    ? code39(text, options)
    : options.format === "ean8"
    ? ean8(text)
    : options.format === "ean13"
    ? ean13(text)
    : code128(text, options);
  const retail = options.format === "ean13" || options.format === "ean8";
  const left = !options.quiet ? 0 : options.format === "ean13" ? 11 : retail ? 7 : 10;
  const right = !options.quiet ? 0 : retail ? 7 : 10;
  const modules = widths.reduce((a, b) => a + b, 0) + left + right;
  const module = Math.max(1, Math.floor(width / modules));
  const out: { x: number; w: number }[] = [];
  let x = left;
  widths.forEach((w, i) => {
    if (i % 2 === 0) out.push({ x: x * module, w: w * module });
    x += w;
  });
  return { module, width: modules * module, bars: out };
}
